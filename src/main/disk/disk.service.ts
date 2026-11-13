import {
  DEFAULT_SECTOR_SIZE,
  type DeviceInventory,
  type Partition,
  type StorageDevice,
} from '@shared/types/disk'
import type { PartitionCandidate } from '@shared/types/partition-search'
import { AppError, ErrorCode, describeUnknown } from '@shared/utils/errors'
import type { Logger } from '../logging/logger'
import { RawBlockDevice, SlicedBlockReader, type BlockReader } from './block-device'
import {
  type CimPartition,
  type CimVolume,
  classifyDevice,
  enumerateStorage,
  isRemovableBus,
  mapBusType,
  mapHealthStatus,
  mapMediaType,
  mapPartitionStyle,
  physicalDrivePath,
} from './device-enumerator'
import { probeFilesystem } from './filesystem-signature'
import { toRecoveredPartitions } from './partition-finder'
import { computeUnallocated, readPartitionTable } from './partition-table'

/**
 * Device inventory.
 *
 * Two sources are combined, deliberately:
 *
 *  - **The OS** knows about drive letters, free space, removability and disks
 *    that are offline or have no readable table.
 *  - **The raw device** is the only place the *actual* partition table and the
 *    *actual* filesystem signatures live.
 *
 * They disagree exactly when it matters. After a bad format Windows reports a
 * healthy empty volume while the raw device still carries the previous
 * filesystem's boot sector — and that boot sector is what makes recovery
 * possible. The raw reading therefore wins wherever both have an opinion.
 *
 * Without elevation the raw pass is skipped rather than failing: the user still
 * gets a device list, clearly marked as limited, instead of an empty screen.
 */
export class DiskService {
  private readonly logger: Logger
  private cached: DeviceInventory | null = null

  constructor(logger: Logger) {
    this.logger = logger.child('disk')
  }

  /** Last inventory, if one has been built this session. */
  getCached(): DeviceInventory | null {
    return this.cached
  }

  /** Enumerate devices, reading partition tables where permitted. */
  async refresh(): Promise<DeviceInventory> {
    const startedAt = Date.now()
    const warnings: string[] = []

    const inventory = await enumerateStorage()

    const sectorSizeByIndex = new Map<number, number>()
    for (const physical of inventory.physical) {
      if (physical.BytesPerSector > 0)
        sectorSizeByIndex.set(physical.Index, physical.BytesPerSector)
    }

    const volumesByLetter = new Map<string, CimVolume>()
    for (const volume of inventory.volumes) {
      const letter = volume.DriveLetter.trim()
      if (letter.length > 0) volumesByLetter.set(letter.toUpperCase(), volume)
    }

    const devices: StorageDevice[] = []
    let hasRawAccess = false

    for (const disk of inventory.disks) {
      const cimPartitions = inventory.partitions.filter(
        (partition) => partition.DiskNumber === disk.Number,
      )

      const device = await this.describeDevice(
        disk,
        cimPartitions,
        volumesByLetter,
        sectorSizeByIndex.get(disk.Number) ?? DEFAULT_SECTOR_SIZE,
        warnings,
      )

      if (device.readError === null && device.partitionStyle !== 'unknown') hasRawAccess = true
      devices.push(device)
    }

    devices.sort((a, b) => a.diskNumber - b.diskNumber)

    this.cached = {
      capturedAt: Date.now(),
      devices,
      hasRawAccess,
      warnings,
    }

    this.logger.info('Device inventory refreshed', {
      devices: devices.length,
      rawAccess: hasRawAccess,
      durationMs: Date.now() - startedAt,
    })

    return this.cached
  }

  /**
   * Open a device for reading.
   * The caller owns the handle and must close it.
   */
  openDevice(deviceId: string): BlockReader {
    const device = this.requireDevice(deviceId)

    return RawBlockDevice.open(device.devicePath, device.sizeBytes, device.logicalSectorSize)
  }

  /**
   * Open a reader restricted to one partition.
   *
   * Returns the parent handle alongside the slice, because a slice deliberately
   * does not close its parent — a caller that closed only the slice would leak
   * the device handle and keep the volume locked.
   */
  openPartition(
    deviceId: string,
    partitionId: string,
  ): { reader: BlockReader; owner: BlockReader } {
    const device = this.requireDevice(deviceId)
    const partition = device.partitions.find((candidate) => candidate.id === partitionId)

    if (partition === undefined) {
      throw new AppError(ErrorCode.NotFound, 'That partition is no longer present', {
        details: partitionId,
        retryable: false,
      })
    }

    const owner = RawBlockDevice.open(device.devicePath, device.sizeBytes, device.logicalSectorSize)

    return {
      owner,
      reader: new SlicedBlockReader(owner, partition.offsetBytes, partition.sizeBytes),
    }
  }

  /**
   * Fold found volumes into the cached inventory as recovered partitions.
   *
   * This is what makes a lost partition usable: once it appears in the
   * inventory it is an ordinary scan target, and scanning, preview, recovery
   * and history all work against it with no special cases. The alternative —
   * a parallel path for "found" volumes threaded through every one of those
   * features — would be far more code and far more places to get the read-only
   * guarantees wrong.
   *
   * Nothing is written to the disk. The partition table on the device is
   * untouched; this changes only how this process describes it. A previous
   * adoption on the same device is replaced rather than appended, so repeating
   * a search does not accumulate duplicates.
   */
  adoptRecoveredPartitions(
    deviceId: string,
    candidates: readonly PartitionCandidate[],
  ): StorageDevice {
    const device = this.requireDevice(deviceId)
    const partitions = toRecoveredPartitions(deviceId, device.partitions, candidates)

    const updated: StorageDevice = {
      ...device,
      partitions,
      // Recomputed so the free-space map stops offering to search regions that
      // a found partition now accounts for.
      unallocated: computeUnallocated(partitions, device.sizeBytes, device.logicalSectorSize),
    }

    this.cached = {
      ...(this.cached ?? { capturedAt: Date.now(), hasRawAccess: true, warnings: [] }),
      devices: (this.cached?.devices ?? []).map((candidate) =>
        candidate.id === deviceId ? updated : candidate,
      ),
    }

    this.logger.info('Adopted recovered partitions', {
      deviceId,
      count: candidates.length,
    })

    return updated
  }

  /** Look up a device from the current inventory. */
  requireDevice(deviceId: string): StorageDevice {
    const device = this.cached?.devices.find((candidate) => candidate.id === deviceId)

    if (device === undefined) {
      throw new AppError(ErrorCode.NotFound, 'That device is no longer connected', {
        details: deviceId,
        retryable: false,
      })
    }

    return device
  }

  // --- internals -----------------------------------------------------------

  private async describeDevice(
    disk: EnumeratedDisk,
    cimPartitions: readonly CimPartition[],
    volumesByLetter: ReadonlyMap<string, CimVolume>,
    sectorSize: number,
    warnings: string[],
  ): Promise<StorageDevice> {
    const id = `disk${disk.Number}`
    const busType = mapBusType(disk.BusType)
    const mediaType = mapMediaType(disk.MediaType)
    const isRemovable = isRemovableBus(busType)

    const base = {
      id,
      diskNumber: disk.Number,
      devicePath: physicalDrivePath(disk.Number),
      model: disk.FriendlyName.trim().length > 0 ? disk.FriendlyName.trim() : 'Unknown device',
      serialNumber: disk.SerialNumber.trim().length > 0 ? disk.SerialNumber.trim() : null,
      sizeBytes: disk.Size,
      logicalSectorSize: disk.LogicalSectorSize > 0 ? disk.LogicalSectorSize : sectorSize,
      physicalSectorSize: disk.PhysicalSectorSize > 0 ? disk.PhysicalSectorSize : sectorSize,
      busType,
      mediaType,
      kind: classifyDevice(busType, mediaType, isRemovable),
      isRemovable,
      isSystem: disk.IsSystem,
      isBoot: disk.IsBoot,
      isOffline: disk.IsOffline,
      health: mapHealthStatus(disk.HealthStatus),
    }

    // An offline disk cannot be read; reporting it is still valuable, because
    // "bring this disk online" is often the whole fix.
    if (disk.IsOffline || disk.Size <= 0) {
      return {
        ...base,
        partitionStyle: mapPartitionStyle(disk.PartitionStyle),
        partitions: this.partitionsFromCim(id, cimPartitions, volumesByLetter),
        unallocated: [],
        readError: disk.IsOffline ? 'The disk is offline' : 'The disk reports no capacity',
      }
    }

    let reader: RawBlockDevice | null = null

    try {
      reader = RawBlockDevice.open(base.devicePath, disk.Size, base.logicalSectorSize)

      const table = await readPartitionTable(reader, id, base.logicalSectorSize)
      warnings.push(...table.warnings.map((warning) => `${base.model}: ${warning}`))

      return {
        ...base,
        partitionStyle: table.style,
        partitions: this.mergePartitions(table.partitions, cimPartitions, volumesByLetter),
        unallocated: [...table.unallocated],
        readError: null,
      }
    } catch (error) {
      const message = error instanceof AppError ? error.message : describeUnknown(error)

      // Elevation is by far the most common cause, and it is actionable — so it
      // is reported as guidance rather than as a failure.
      this.logger.warn('Falling back to OS partition data', {
        device: base.devicePath,
        reason: message,
      })

      return {
        ...base,
        partitionStyle: mapPartitionStyle(disk.PartitionStyle),
        partitions: this.partitionsFromCim(id, cimPartitions, volumesByLetter),
        unallocated: [],
        readError: message,
      }
    } finally {
      reader?.close()
    }
  }

  /**
   * Attach drive letters and free space to partitions read from the raw table.
   *
   * Matching is by byte offset, which is the only identifier both sources agree
   * on — partition *numbers* differ between the OS view and the on-disk order
   * once logical partitions are involved.
   */
  private mergePartitions(
    parsed: readonly Partition[],
    cimPartitions: readonly CimPartition[],
    volumesByLetter: ReadonlyMap<string, CimVolume>,
  ): Partition[] {
    return parsed.map((partition) => {
      const match = cimPartitions.find(
        (candidate) => Math.abs(candidate.Offset - partition.offsetBytes) < 1,
      )

      if (match === undefined) return partition

      const letter = match.DriveLetter.trim().toUpperCase()
      const volume = letter.length > 0 ? volumesByLetter.get(letter) : undefined

      return {
        ...partition,
        driveLetter: letter.length > 0 ? letter : null,
        // The filesystem label is only available from the OS once the volume is
        // mounted; the raw probe cannot read it for NTFS or exFAT.
        label: partition.label ?? nullIfBlank(volume?.FileSystemLabel),
        freeBytes: volume !== undefined ? volume.SizeRemaining : null,
        isHidden: partition.isHidden || match.IsHidden,
      }
    })
  }

  /**
   * Build partitions from the OS view alone.
   *
   * Used when the raw device cannot be opened. The result is less trustworthy —
   * it reflects what Windows currently believes, not what is on the platter —
   * so the caller marks the device with a `readError` to say so.
   */
  private partitionsFromCim(
    deviceId: string,
    cimPartitions: readonly CimPartition[],
    volumesByLetter: ReadonlyMap<string, CimVolume>,
  ): Partition[] {
    return cimPartitions
      .slice()
      .sort((a, b) => a.Offset - b.Offset)
      .map((partition, position) => {
        const letter = partition.DriveLetter.trim().toUpperCase()
        const volume = letter.length > 0 ? volumesByLetter.get(letter) : undefined

        return {
          id: `${deviceId}:p${partition.PartitionNumber || position + 1}`,
          deviceId,
          index: partition.PartitionNumber || position + 1,
          offsetBytes: partition.Offset,
          sizeBytes: partition.Size,
          fileSystem: normaliseOsFileSystem(volume?.FileSystem),
          label: nullIfBlank(volume?.FileSystemLabel),
          driveLetter: letter.length > 0 ? letter : null,
          typeCode:
            partition.GptType.length > 0
              ? partition.GptType
              : `0x${partition.MbrType.toString(16)}`,
          typeName: partition.GptType.length > 0 ? 'GPT partition' : 'MBR partition',
          isBootable: partition.IsBoot || partition.IsActive,
          isHidden: partition.IsHidden,
          isRecovered: false,
          freeBytes: volume !== undefined ? volume.SizeRemaining : null,
        }
      })
  }
}

/** Shape of one entry from `enumerateStorage().disks`. */
type EnumeratedDisk = Awaited<ReturnType<typeof enumerateStorage>>['disks'][number]

function nullIfBlank(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? ''
  return trimmed.length > 0 ? trimmed : null
}

/** Map the OS filesystem name onto our own enumeration. */
function normaliseOsFileSystem(value: string | undefined): Partition['fileSystem'] {
  switch (value?.trim().toUpperCase()) {
    case 'NTFS':
      return 'ntfs'
    case 'FAT32':
      return 'fat32'
    case 'FAT':
    case 'FAT16':
      return 'fat16'
    case 'FAT12':
      return 'fat12'
    case 'EXFAT':
      return 'exfat'
    case 'REFS':
      return 'refs'
    case 'CDFS':
      return 'iso9660'
    case 'UDF':
      return 'udf'
    case '':
    case undefined:
      return 'unknown'
    default:
      return 'unknown'
  }
}

/** Probe a specific byte range for a filesystem — used by partition recovery. */
export async function probeRegion(
  reader: BlockReader,
  offsetBytes: number,
  sizeBytes: number,
): Promise<ReturnType<typeof probeFilesystem>> {
  return probeFilesystem(new SlicedBlockReader(reader, offsetBytes, sizeBytes))
}
