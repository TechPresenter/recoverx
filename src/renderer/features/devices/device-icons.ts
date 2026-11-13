import {
  Camera,
  Disc,
  HardDrive,
  MemoryStick,
  Server,
  Smartphone,
  Usb,
  type LucideIcon,
} from 'lucide-react'
import type { DeviceKind } from '@shared/types/disk'

/**
 * Icon per device class.
 *
 * Kept apart from the page component so the mapping is exhaustive by type — a
 * new `DeviceKind` becomes a compile error here rather than a device that
 * silently renders with no icon.
 */
export const DEVICE_KIND_ICONS: Readonly<Record<DeviceKind, LucideIcon>> = {
  'hard-disk': HardDrive,
  ssd: HardDrive,
  nvme: MemoryStick,
  'external-hdd': HardDrive,
  'external-ssd': HardDrive,
  'usb-flash': Usb,
  'sd-card': MemoryStick,
  'micro-sd': Smartphone,
  'camera-card': Camera,
  optical: Disc,
  'virtual-disk': Server,
  unknown: HardDrive,
}
