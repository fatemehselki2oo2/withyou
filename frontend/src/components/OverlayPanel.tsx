import { useEffect, useId, useRef, type ReactNode } from 'react'

interface OverlayPanelProps {
  open: boolean
  title: string
  description?: string
  wide?: boolean
  onClose: () => void
  children: ReactNode
}

/** A dependency-free version of shadcn's responsive Dialog/Drawer pattern. */
export function OverlayPanel({ open, title, description, wide = false, onClose, children }: OverlayPanelProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const titleId = useId()

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  return (
    <dialog
      ref={dialogRef}
      className={`overlay-panel ${wide ? 'wide' : ''}`}
      aria-labelledby={titleId}
      aria-hidden={!open}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="overlay-panel-surface">
        <header className="overlay-panel-header">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <button type="button" className="icon-button" aria-label={`Close ${title}`} onClick={onClose}>×</button>
        </header>
        <div className="overlay-panel-body">{children}</div>
      </div>
    </dialog>
  )
}
