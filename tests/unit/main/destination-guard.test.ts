import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  assertUsableDestination,
  describeProblem,
  resolveDeviceForPath,
  validateDestination,
} from '@main/recovery/destination-guard'
import type { Partition, StorageDevice } from '@shared/types/disk'

function partition(driveLetter: string | null, index = 1): Partition {
  return {
    id: `p${index}`,
    deviceId: 'disk0',
    index,
    offsetBytes: 0,
    sizeBytes: 1000,
    fileSystem: 'ntfs',
    label: null,
    driveLetter,
    typeCode: '0x07',
    typeName: 'NTFS',
    isBootable: false,
    isHidden: false,
    isRecovered: false,
    freeBytes: null,
  }
}

function device(id: string, letters: Array<string | null>): StorageDevice {
  return {
    id,
    diskNumber: Number(id.replace('disk', '')),
    devicePath: `\\\\.\\PhysicalDrive${id.replace('disk', '')}`,
    model: `Model ${id}`,
    serialNumber: null,
    sizeBytes: 1_000_000,
    logicalSectorSize: 512,
    physicalSectorSize: 512,
    busType: 'sata',
    mediaType: 'ssd',
    kind: 'ssd',
    partitionStyle: 'gpt',
    isRemovable: false,
    isSystem: false,
    isBoot: false,
    isOffline: false,
    health: 'healthy',
    partitions: letters.map((letter, index) => ({
      ...partition(letter, index + 1),
      deviceId: id,
      id: `${id}:p${index + 1}`,
    })),
    unallocated: [],
    readError: null,
  }
}

// One physical disk carrying both C: and D: — the case that matters most.
const DISK0 = device('disk0', ['C', 'D'])
const DISK1 = device('disk1', ['E'])
const DEVICES = [DISK0, DISK1]

describe('resolveDeviceForPath', () => {
  it('maps a drive letter to the device that owns it', () => {
    expect(resolveDeviceForPath('C:\\Users\\Anna', DEVICES).deviceId).toBe('disk0')
    expect(resolveDeviceForPath('E:\\Backup', DEVICES).deviceId).toBe('disk1')
  })

  it('maps two letters on one physical disk to the same device', () => {
    // The whole point: D: is a different letter but not a different device.
    expect(resolveDeviceForPath('D:\\Recovered', DEVICES).deviceId).toBe('disk0')
  })

  it('is case-insensitive', () => {
    expect(resolveDeviceForPath('c:\\temp', DEVICES).deviceId).toBe('disk0')
  })

  it('treats a UNC path as non-local, so it can never be the source', () => {
    const result = resolveDeviceForPath('\\\\server\\share\\folder', DEVICES)

    expect(result.deviceId).toBeNull()
    expect(result.isLocalVolume).toBe(false)
  })

  it('reports an unmappable drive letter as local, so the caller refuses', () => {
    const result = resolveDeviceForPath('Z:\\Somewhere', DEVICES)

    expect(result.deviceId).toBeNull()
    expect(result.isLocalVolume).toBe(true)
  })
})

describe('validateDestination', () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'recoverx-dest-'))
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  /** The device list, rigged so the temp directory's letter maps as asked. */
  const devicesFor = (letterOwner: string): StorageDevice[] => {
    const letter = /^([A-Za-z]):/u.exec(parse(directory).root)?.[1]?.toUpperCase() ?? 'C'
    return [device(letterOwner, [letter]), device('diskOther', ['Q'])]
  }

  it('accepts a writable folder on a different device', async () => {
    const check = await validateDestination({
      destination: directory,
      sourceDeviceId: 'diskSource',
      devices: devicesFor('diskDestination'),
      requiredBytes: 1024,
    })

    expect(check.isUsable).toBe(true)
    expect(check.problem).toBeNull()
  })

  it('refuses the device the data is being recovered from', async () => {
    // The single most important assertion in the recovery module.
    const check = await validateDestination({
      destination: directory,
      sourceDeviceId: 'diskSource',
      devices: devicesFor('diskSource'),
      requiredBytes: 1024,
    })

    expect(check.isUsable).toBe(false)
    expect(check.problem).toBe('same-device')
  })

  it('reports the source device before any other problem', async () => {
    // A user who picked the source drive must be told that, not that they are
    // short on space.
    const check = await validateDestination({
      destination: directory,
      sourceDeviceId: 'diskSource',
      devices: devicesFor('diskSource'),
      requiredBytes: Number.MAX_SAFE_INTEGER,
    })

    expect(check.problem).toBe('same-device')
  })

  it('refuses a volume it cannot attribute to any device', async () => {
    // Unknown local volume might be the source; refusing is the safe default.
    const check = await validateDestination({
      destination: directory,
      sourceDeviceId: 'diskSource',
      devices: [device('diskOther', ['Q'])],
      requiredBytes: 1024,
    })

    expect(check.isUsable).toBe(false)
    expect(check.problem).toBe('unresolvable-volume')
  })

  it('refuses a relative path', async () => {
    const check = await validateDestination({
      destination: 'Recovered',
      sourceDeviceId: 'diskSource',
      devices: DEVICES,
      requiredBytes: 1024,
    })

    expect(check.problem).toBe('not-absolute')
  })

  it('refuses a folder that does not exist', async () => {
    const check = await validateDestination({
      destination: join(directory, 'missing'),
      sourceDeviceId: 'diskSource',
      devices: devicesFor('diskDestination'),
      requiredBytes: 1024,
    })

    expect(check.problem).toBe('does-not-exist')
  })

  it('refuses a file', async () => {
    const file = join(directory, 'a-file.txt')
    writeFileSync(file, 'x')

    const check = await validateDestination({
      destination: file,
      sourceDeviceId: 'diskSource',
      devices: devicesFor('diskDestination'),
      requiredBytes: 1024,
    })

    expect(check.problem).toBe('not-a-directory')
  })

  it('refuses when there is not enough free space', async () => {
    const check = await validateDestination({
      destination: directory,
      sourceDeviceId: 'diskSource',
      devices: devicesFor('diskDestination'),
      requiredBytes: Number.MAX_SAFE_INTEGER,
    })

    expect(check.problem).toBe('insufficient-space')
    expect(check.freeBytes).toBeGreaterThan(0)
  })

  it('reports real capacity figures for a usable destination', async () => {
    const check = await validateDestination({
      destination: directory,
      sourceDeviceId: 'diskSource',
      devices: devicesFor('diskDestination'),
      requiredBytes: 1,
    })

    expect(check.totalBytes).toBeGreaterThan(0)
    expect(check.freeBytes).toBeGreaterThan(0)
  })
})

describe('assertUsableDestination', () => {
  const base = { path: 'D:\\x', freeBytes: 0, totalBytes: 0, deviceId: null }

  it('passes a usable destination', () => {
    expect(() => {
      assertUsableDestination({ ...base, isUsable: true, problem: null })
    }).not.toThrow()
  })

  it('throws a security violation for the source device', () => {
    // Classified distinctly so it can never be presented as a routine
    // validation message the user might be tempted to work around.
    expect(() => {
      assertUsableDestination({ ...base, isUsable: false, problem: 'same-device' })
    }).toThrow(/same device/i)
  })

  it('throws for every other problem', () => {
    expect(() => {
      assertUsableDestination({ ...base, isUsable: false, problem: 'not-writable' })
    }).toThrow(/cannot be written/i)
  })
})

describe('describeProblem', () => {
  it('explains why, not just what', () => {
    expect(describeProblem('same-device')).toContain('overwrite the files still waiting')
  })

  it('covers every problem and the null case', () => {
    const problems = [
      'same-device',
      'does-not-exist',
      'not-a-directory',
      'not-writable',
      'insufficient-space',
      'unresolvable-volume',
      'not-absolute',
      null,
    ] as const

    for (const problem of problems) {
      expect(describeProblem(problem).length).toBeGreaterThan(10)
    }
  })
})
