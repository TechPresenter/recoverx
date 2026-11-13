import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Button } from '@/components/ui/Button'
import { ProgressBar } from '@/components/ui/ProgressBar'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { Switch } from '@/components/ui/Switch'

describe('Button', () => {
  it('renders its label and fires onClick', async () => {
    const onClick = vi.fn()
    render(<Button onClick={onClick}>Recover</Button>)

    await userEvent.click(screen.getByRole('button', { name: 'Recover' }))

    expect(onClick).toHaveBeenCalledOnce()
  })

  it('blocks interaction while loading and announces it', async () => {
    const onClick = vi.fn()
    render(
      <Button loading onClick={onClick}>
        Recover
      </Button>,
    )

    const button = screen.getByRole('button')
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')

    await userEvent.click(button)
    expect(onClick).not.toHaveBeenCalled()
  })

  it('keeps the label mounted while loading so the width does not change', () => {
    render(<Button loading>Recover</Button>)

    // Hidden visually, but still in the layout — otherwise the button resizes
    // under the user's cursor mid-click.
    expect(screen.getByText('Recover')).toBeInTheDocument()
  })

  it('defaults to type="button" so it cannot submit an enclosing form', () => {
    render(<Button>Save</Button>)

    expect(screen.getByRole('button')).toHaveAttribute('type', 'button')
  })

  it('does not fire when disabled', async () => {
    const onClick = vi.fn()
    render(
      <Button disabled onClick={onClick}>
        Recover
      </Button>,
    )

    await userEvent.click(screen.getByRole('button'))
    expect(onClick).not.toHaveBeenCalled()
  })
})

describe('Switch', () => {
  it('exposes the correct role and checked state', () => {
    render(<Switch checked label="Telemetry" onCheckedChange={vi.fn()} />)

    expect(screen.getByRole('switch')).toBeChecked()
  })

  it('toggles to the opposite value on click', async () => {
    const onCheckedChange = vi.fn()
    render(<Switch checked={false} label="Telemetry" onCheckedChange={onCheckedChange} />)

    await userEvent.click(screen.getByRole('switch'))

    expect(onCheckedChange).toHaveBeenCalledWith(true)
  })

  it('is operable by keyboard', async () => {
    const onCheckedChange = vi.fn()
    render(<Switch checked={false} label="Telemetry" onCheckedChange={onCheckedChange} />)

    await userEvent.tab()
    await userEvent.keyboard('{Enter}')

    expect(onCheckedChange).toHaveBeenCalledWith(true)
  })

  it('associates its label and description for screen readers', () => {
    render(
      <Switch
        checked
        label="Telemetry"
        description="Sends anonymous crash reports"
        onCheckedChange={vi.fn()}
      />,
    )

    const control = screen.getByRole('switch', { name: 'Telemetry' })
    expect(control).toHaveAccessibleDescription('Sends anonymous crash reports')
  })

  it('cannot be toggled while a write is in flight', async () => {
    const onCheckedChange = vi.fn()
    render(<Switch checked={false} pending label="Telemetry" onCheckedChange={onCheckedChange} />)

    await userEvent.click(screen.getByRole('switch'))

    expect(onCheckedChange).not.toHaveBeenCalled()
  })
})

describe('SegmentedControl', () => {
  const segments = [
    { value: 'all', label: 'All' },
    { value: 'error', label: 'Error' },
    { value: 'warn', label: 'Warn' },
  ] as const

  it('marks the selected segment and exposes a radiogroup', () => {
    render(
      <SegmentedControl
        value="error"
        segments={segments}
        onValueChange={vi.fn()}
        ariaLabel="Level"
      />,
    )

    expect(screen.getByRole('radiogroup', { name: 'Level' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Error' })).toBeChecked()
  })

  it('selects on click', async () => {
    const onValueChange = vi.fn()
    render(
      <SegmentedControl
        value="all"
        segments={segments}
        onValueChange={onValueChange}
        ariaLabel="Level"
      />,
    )

    await userEvent.click(screen.getByRole('radio', { name: 'Warn' }))

    expect(onValueChange).toHaveBeenCalledWith('warn')
  })

  it('moves selection with the arrow keys, as a radio group should', async () => {
    const onValueChange = vi.fn()
    render(
      <SegmentedControl
        value="all"
        segments={segments}
        onValueChange={onValueChange}
        ariaLabel="Level"
      />,
    )

    await userEvent.tab()
    await userEvent.keyboard('{ArrowRight}')

    expect(onValueChange).toHaveBeenCalledWith('error')
  })

  it('wraps around at the ends, matching native radio behaviour', async () => {
    const onValueChange = vi.fn()
    render(
      <SegmentedControl
        value="all"
        segments={segments}
        onValueChange={onValueChange}
        ariaLabel="Level"
      />,
    )

    await userEvent.tab()
    await userEvent.keyboard('{ArrowLeft}')

    expect(onValueChange).toHaveBeenCalledWith('warn')
  })

  it('keeps the group to a single tab stop', () => {
    render(
      <SegmentedControl
        value="error"
        segments={segments}
        onValueChange={vi.fn()}
        ariaLabel="Level"
      />,
    )

    expect(screen.getByRole('radio', { name: 'Error' })).toHaveAttribute('tabindex', '0')
    expect(screen.getByRole('radio', { name: 'All' })).toHaveAttribute('tabindex', '-1')
  })
})

describe('ProgressBar', () => {
  it('exposes its value to assistive technology', () => {
    render(<ProgressBar value={42} ariaLabel="Scan progress" />)

    const bar = screen.getByRole('progressbar', { name: 'Scan progress' })
    expect(bar).toHaveAttribute('aria-valuenow', '42')
  })

  it('clamps values outside 0-100 rather than overflowing its track', () => {
    const { rerender } = render(<ProgressBar value={150} ariaLabel="p" />)
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100')

    rerender(<ProgressBar value={-20} ariaLabel="p" />)
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0')

    rerender(<ProgressBar value={Number.NaN} ariaLabel="p" />)
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0')
  })
})
