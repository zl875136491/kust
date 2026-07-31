import { useEffect } from 'react';
import { useVisualEffects } from '../visual-effects-context';

const PANEL_FILTER_ID = 'kust-liquid-panel';

function supportsEnhancedGlass() {
  const supportsBackdrop = CSS.supports('backdrop-filter', 'blur(12px)')
    || CSS.supports('-webkit-backdrop-filter', 'blur(12px)');
  const supportsSvgFilter = CSS.supports('filter', `url("#${PANEL_FILTER_ID}")`);
  const isFirefox = navigator.userAgent.toLowerCase().includes('firefox');

  return supportsBackdrop && supportsSvgFilter && !isFirefox;
}

export function LiquidGlassSystem() {
  const { effects } = useVisualEffects();

  useEffect(() => {
    const root = document.documentElement;
    const finePointer = window.matchMedia('(pointer: fine)');
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const desktopViewport = window.matchMedia('(min-width: 761px)');
    let animationFrame = 0;

    const clearPointerLight = () => {
      ['--glass-light-x', '--glass-light-y', '--glass-light-angle', '--glass-rim-x', '--glass-rim-y']
        .forEach((property) => root.style.removeProperty(property));
    };

    const allowsPointerLight = () => effects.pointerHighlight
      && finePointer.matches
      && !reducedMotion.matches
      && desktopViewport.matches;

    const updateCapability = () => {
      root.dataset.liquidGlass = effects.refraction
        && supportsEnhancedGlass()
        && finePointer.matches
        && !reducedMotion.matches
        && desktopViewport.matches
        ? 'enhanced'
        : 'fallback';
      if (!allowsPointerLight()) clearPointerLight();
    };

    const updateLight = (event: PointerEvent) => {
      if (!allowsPointerLight()) return;
      const x = Math.min(1, Math.max(0, event.clientX / window.innerWidth));
      const y = Math.min(1, Math.max(0, event.clientY / window.innerHeight));

      cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(() => {
        root.style.setProperty('--glass-light-x', `${20 + x * 60}%`);
        root.style.setProperty('--glass-light-y', `${12 + y * 76}%`);
        root.style.setProperty('--glass-light-angle', `${112 + x * 32 - y * 18}deg`);
        root.style.setProperty('--glass-rim-x', `${(0.5 - x) * 1.6}px`);
        root.style.setProperty('--glass-rim-y', `${(0.5 - y) * 1.6}px`);
      });
    };

    updateCapability();
    finePointer.addEventListener('change', updateCapability);
    reducedMotion.addEventListener('change', updateCapability);
    desktopViewport.addEventListener('change', updateCapability);
    window.addEventListener('pointermove', updateLight, { passive: true });

    return () => {
      cancelAnimationFrame(animationFrame);
      finePointer.removeEventListener('change', updateCapability);
      reducedMotion.removeEventListener('change', updateCapability);
      desktopViewport.removeEventListener('change', updateCapability);
      window.removeEventListener('pointermove', updateLight);
      delete root.dataset.liquidGlass;
      clearPointerLight();
    };
  }, [effects.pointerHighlight, effects.refraction]);

  return (
    <svg className="liquid-glass-defs" width="0" height="0" aria-hidden="true">
      <defs>
        <filter
          id={PANEL_FILTER_ID}
          x="-12%"
          y="-12%"
          width="124%"
          height="124%"
          colorInterpolationFilters="sRGB"
        >
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.009 0.016"
            numOctaves="2"
            seed="23"
            result="panelNoise"
          />
          <feGaussianBlur in="panelNoise" stdDeviation="0.85" result="panelNoiseSoft" />
          <feDisplacementMap
            in="SourceGraphic"
            in2="panelNoiseSoft"
            scale="10"
            xChannelSelector="R"
            yChannelSelector="B"
            result="panelWarp"
          />
          <feColorMatrix in="panelWarp" type="saturate" values="1.08" />
        </filter>
      </defs>
    </svg>
  );
}
