/* eslint-disable react-refresh/only-export-components */
import { AlertTriangle, Check, ChevronDown, Info, X } from 'lucide-react';
import {
  createContext,
  type ButtonHTMLAttributes,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useAnimatedPresence, useEscapeLayer } from '../hooks/useEscapeLayer';

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  icon?: ReactNode;
}

export function Button({ variant = 'secondary', icon, className = '', children, ...props }: ButtonProps) {
  return (
    <button className={`button button--${variant} ${className}`} {...props}>
      {icon}
      {children && <span>{children}</span>}
    </button>
  );
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  active?: boolean;
}

export function IconButton({ label, active, className = '', children, ...props }: IconButtonProps) {
  return (
    <button
      type="button"
      className={`icon-button ${active ? 'is-active' : ''} ${className}`}
      aria-label={label}
      title={label}
      {...props}
    >
      {children}
    </button>
  );
}

export interface SelectMenuOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface SelectMenuProps {
  value: string;
  options: SelectMenuOption[];
  onChange: (value: string) => void;
  label?: string;
  className?: string;
  'aria-label'?: string;
}

/** Cross-platform glass select; native menus vary substantially between browsers and OSes. */
export function SelectMenu({ value, options, onChange, label, className = '', 'aria-label': ariaLabel }: SelectMenuProps) {
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(() => Math.max(0, options.findIndex((option) => option.value === value)));
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const selected = options.find((option) => option.value === value) || options[0];

  useEffect(() => {
    const next = options.findIndex((option) => option.value === value);
    setHighlighted(next >= 0 ? next : 0);
  }, [options, value]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !popoverRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener('mousedown', closeOnOutside);
    return () => document.removeEventListener('mousedown', closeOnOutside);
  }, [open]);

  useEscapeLayer(open, () => setOpen(false), 90);

  const choose = (option?: SelectMenuOption) => {
    if (!option) return;
    if (option.disabled) return;
    onChange(option.value);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const moveHighlight = (direction: 1 | -1) => {
    if (!options.length) return;
    let next = highlighted;
    for (let i = 0; i < options.length; i += 1) {
      next = (next + direction + options.length) % options.length;
      if (!options[next]?.disabled) break;
    }
    setHighlighted(next);
  };

  const onTriggerKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) setOpen(true);
      moveHighlight(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (open) choose(options[highlighted]); else setOpen(true);
    } else if (event.key === 'Escape' && open) {
      event.preventDefault();
      setOpen(false);
    }
  };

  const [position, setPosition] = useState<{ left: number; top: number; width: number; maxHeight: number }>();
  const updatePosition = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.max(rect.width, 170);
    const availableBelow = window.innerHeight - rect.bottom - 12;
    const availableAbove = rect.top - 12;
    const contentHeight = Math.max(140, Math.min(320, options.length * 36 + 12));
    const maxHeight = Math.max(140, Math.min(320, Math.max(availableBelow, availableAbove)));
    const above = availableBelow < Math.min(180, contentHeight) && availableAbove > availableBelow;
    setPosition({
      left: Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8)),
      top: above ? Math.max(8, rect.top - Math.min(contentHeight, maxHeight) - 6) : rect.bottom + 6,
      width,
      maxHeight,
    });
  }, [options.length]);

  useEffect(() => {
    if (!open) return;
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open, updatePosition]);

  return (
    <div className={`select-menu ${className}`}>
      {label && <span className="select-menu__label">{label}</span>}
      <button
        ref={triggerRef}
        type="button"
        className="select-menu__trigger"
        role="combobox"
        aria-label={ariaLabel || label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="select-menu__value">{selected?.label || '请选择'}</span>
        <ChevronDown size={14} className={`select-menu__chevron ${open ? 'is-open' : ''}`} aria-hidden="true" />
      </button>
      {open && createPortal(
        <div
          ref={popoverRef}
          id={listId}
          className="select-menu__popover"
          role="listbox"
          aria-label={ariaLabel || label}
          style={{ left: position?.left || 8, top: position?.top || 8, width: position?.width || 200, maxHeight: position?.maxHeight || 300 }}
        >
          {options.map((option, index) => (
            <button
              type="button"
              role="option"
              aria-selected={option.value === value}
              aria-disabled={option.disabled || undefined}
              disabled={option.disabled}
              className={`select-menu__option ${option.value === value ? 'is-selected' : ''} ${index === highlighted ? 'is-highlighted' : ''}`}
              key={option.value}
              onMouseEnter={() => setHighlighted(index)}
              onClick={() => choose(option)}
            >
              <span>{option.label}</span>
              {option.value === value && <Check size={14} aria-hidden="true" />}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode | ((requestClose: () => void) => ReactNode);
  width?: string;
  dirty?: boolean;
  closeDisabled?: boolean;
  onSave?: () => boolean | void | Promise<boolean | void>;
  onDiscard?: () => void;
  priority?: number;
}

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = '560px',
  dirty = false,
  closeDisabled = false,
  onSave,
  onDiscard,
  priority = 100,
}: ModalProps) {
  const titleId = useId();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const { mounted, closing } = useAnimatedPresence(open, 210);

  const requestClose = useCallback(() => {
    if (closeDisabled) return;
    if (dirty) {
      setConfirmOpen(true);
      return;
    }
    onClose();
  }, [closeDisabled, dirty, onClose]);

  useEscapeLayer(open && !confirmOpen, requestClose, priority);

  useEffect(() => {
    if (!open) {
      setConfirmOpen(false);
      setSaving(false);
    }
  }, [open]);

  const discardAndClose = () => {
    onDiscard?.();
    setConfirmOpen(false);
    onClose();
  };
  const saveAndClose = async () => {
    if (!onSave || saving) return;
    setSaving(true);
    try {
      const saved = await onSave();
      if (saved === false) return;
      setConfirmOpen(false);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  if (!mounted) return null;
  const footerContent = typeof footer === 'function' ? footer(requestClose) : footer;

  return <>
    {createPortal(
    <div
      className={`modal-backdrop ${closing ? 'is-closing' : ''}`}
      role="presentation"
      style={{ zIndex: priority }}
      onMouseDown={(event) => event.target === event.currentTarget && requestClose()}
    >
      <section className={`modal glass-panel ${closing ? 'is-closing' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} style={{ maxWidth: width }}>
        <header className="modal__header">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <IconButton label="关闭" onClick={requestClose} disabled={closeDisabled}><X size={18} /></IconButton>
        </header>
        <div className="modal__body">{children}</div>
        {footerContent && <footer className="modal__footer">{footerContent}</footer>}
      </section>
    </div>,
    document.body,
    )}
    <UnsavedChangesPrompt
      open={confirmOpen}
      saving={saving}
      onContinue={() => setConfirmOpen(false)}
      onDiscard={discardAndClose}
      onSave={onSave ? () => void saveAndClose() : undefined}
      priority={priority + 20}
    />
  </>;
}

export function UnsavedChangesPrompt({
  open,
  saving = false,
  onContinue,
  onDiscard,
  onSave,
  priority = 120,
}: {
  open: boolean;
  saving?: boolean;
  onContinue: () => void;
  onDiscard: () => void;
  onSave?: () => void;
  priority?: number;
}) {
  return (
    <Modal
      open={open}
      onClose={onContinue}
      title="保存当前更改？"
      description="关闭后，尚未保存的内容将不会保留。"
      width="460px"
      closeDisabled={saving}
      priority={priority}
      footer={<>
        <Button variant="ghost" onClick={onContinue} disabled={saving}>继续编辑</Button>
        <Button variant="danger" onClick={onDiscard} disabled={saving}>放弃更改</Button>
        {onSave && <Button variant="primary" onClick={onSave} disabled={saving}>{saving ? '保存中' : '保存并关闭'}</Button>}
      </>}
    >
      <p className="confirm-copy">你可以先保存，也可以放弃本次修改后关闭。</p>
    </Modal>
  );
}

export function StatusPill({ status }: { status: string }) {
  const normalized = status.toLowerCase();
  const tone = /ready|running|active|bound|complete|succeeded|connected|normal/.test(normalized)
    ? 'success'
    : /warning|progress|pending|unknown|suspended/.test(normalized)
      ? 'warning'
      : /fail|error|crash|notready|disconnected|backoff/.test(normalized)
        ? 'danger'
        : 'neutral';
  return <span className={`status status--${tone}`}><i />{status}</span>;
}

export function Spinner({ label = '加载中' }: { label?: string }) {
  return <div className="loading" role="status"><span className="spinner" /><span>{label}</span></div>;
}

export function EmptyState({ icon, title, body, action }: { icon: ReactNode; title: string; body?: string; action?: ReactNode }) {
  return <div className="empty-state"><div className="empty-state__icon">{icon}</div><h3>{title}</h3>{body && <p>{body}</p>}{action}</div>;
}

type ToastTone = 'success' | 'error' | 'info';
interface ToastMessage { id: number; tone: ToastTone; message: string }
interface ToastContextValue { pushToast: (message: string, tone?: ToastTone) => void }
const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const pushToast = useCallback((message: string, tone: ToastTone = 'success') => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, tone, message }]);
    window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 3600);
  }, []);
  const value = useMemo(() => ({ pushToast }), [pushToast]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-stack" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast--${toast.tone}`}>
            {toast.tone === 'success' ? <Check size={17} /> : toast.tone === 'error' ? <AlertTriangle size={17} /> : <Info size={17} />}
            <span>{toast.message}</span>
            <IconButton label="关闭" onClick={() => setToasts((current) => current.filter((item) => item.id !== toast.id))}><X size={15} /></IconButton>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const value = useContext(ToastContext);
  if (!value) throw new Error('useToast must be used inside ToastProvider');
  return value;
}
