import { useEffect, useRef, useState } from 'react';

interface EscapeLayer {
  id: symbol;
  order: number;
  priority: number;
  onEscape: () => void;
}

const escapeLayers = new Map<symbol, EscapeLayer>();
let layerOrder = 0;
let listening = false;

function handleEscape(event: KeyboardEvent) {
  if (event.key !== 'Escape' || event.defaultPrevented || event.repeat) return;

  let topLayer: EscapeLayer | undefined;
  escapeLayers.forEach((layer) => {
    if (!topLayer || layer.priority > topLayer.priority ||
      (layer.priority === topLayer.priority && layer.order > topLayer.order)) {
      topLayer = layer;
    }
  });
  if (!topLayer) return;

  event.preventDefault();
  event.stopPropagation();
  topLayer.onEscape();
}

function syncEscapeListener() {
  if (escapeLayers.size > 0 && !listening) {
    window.addEventListener('keydown', handleEscape, true);
    listening = true;
  } else if (escapeLayers.size === 0 && listening) {
    window.removeEventListener('keydown', handleEscape, true);
    listening = false;
  }
}

export function useEscapeLayer(active: boolean, onEscape: () => void, priority = 0) {
  const callbackRef = useRef(onEscape);
  const idRef = useRef<symbol | null>(null);
  callbackRef.current = onEscape;
  if (!idRef.current) idRef.current = Symbol('escape-layer');

  useEffect(() => {
    if (!active || !idRef.current) return;
    const id = idRef.current;
    escapeLayers.set(id, {
      id,
      order: ++layerOrder,
      priority,
      onEscape: () => callbackRef.current(),
    });
    syncEscapeListener();

    return () => {
      escapeLayers.delete(id);
      syncEscapeListener();
    };
  }, [active, priority]);
}

export function motionDuration(duration: number) {
  if (typeof window === 'undefined') return duration;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  return reducedMotion ? 0 : duration;
}

export function useAnimatedPresence(open: boolean, duration = 220) {
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    if (open) {
      setMounted(true);
      setClosing(false);
      return;
    }
    if (!mounted) return;

    setClosing(true);
    const timer = window.setTimeout(() => {
      setMounted(false);
      setClosing(false);
    }, motionDuration(duration));
    return () => window.clearTimeout(timer);
  }, [duration, mounted, open]);

  return { mounted, closing };
}
