/* eslint-disable react-refresh/only-export-components */
import { AlertTriangle, Check, Info, X } from 'lucide-react';
import {
  createContext,
  type ButtonHTMLAttributes,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
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
