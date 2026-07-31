import { Check, Database, Laptop, Moon, Palette, Rows3, Sparkles, Sun } from 'lucide-react';
import { useState } from 'react';
import { useData } from '../data-context';
import { useThemeMode } from '../theme-context';
import type { DataMode, ThemeMode } from '../types';
import { useVisualEffects } from '../visual-effects-context';
import { Button, useToast } from '../components/ui';

export function SettingsPage() {
  const { mode, setMode, clusters } = useData();
  const { mode: theme, setMode: setTheme } = useThemeMode();
  const { effects, setEffect } = useVisualEffects();
  const { pushToast } = useToast();
  const [autoRefresh, setAutoRefresh] = useState(() => localStorage.getItem('kust-auto-refresh') !== 'false');
  const [rows, setRows] = useState(() => Number(localStorage.getItem('kust-page-size') || 25));
  const themes: { value: ThemeMode; label: string; icon: React.ReactNode }[] = [
    { value: 'system', label: '系统', icon: <Laptop size={19} /> },
    { value: 'light', label: '浅色', icon: <Sun size={19} /> },
    { value: 'dark', label: '深色', icon: <Moon size={19} /> },
  ];
  const dataModes: { value: DataMode; label: string }[] = [{ value: 'demo', label: '演示数据' }, { value: 'live', label: '实时后端' }];

  const save = () => {
    localStorage.setItem('kust-auto-refresh', String(autoRefresh));
    localStorage.setItem('kust-page-size', String(rows));
    pushToast('设置已保存');
  };

  return (
    <div className="page settings-page">
      <header className="page-header"><div><span className="eyebrow">preferences</span><h2>设置</h2></div><Button variant="primary" icon={<Check size={17} />} onClick={save}>保存</Button></header>
      <div className="settings-layout">
        <section className="settings-section settings-section--appearance glass-card"><header><Palette size={19} /><div><h3>外观</h3></div></header><div className="theme-options">{themes.map((item) => <button key={item.value} className={theme === item.value ? 'is-selected' : ''} onClick={() => setTheme(item.value)}>{item.icon}<span>{item.label}</span>{theme === item.value && <Check size={15} />}</button>)}</div></section>
        <section className="settings-section settings-section--effects glass-card">
          <header><Sparkles size={19} /><div><h3>玻璃效果</h3></div></header>
          <div className="setting-row"><div><strong>指针跟随高光</strong><span>桌面交互</span></div><label className="switch-control"><input aria-label="指针跟随高光" type="checkbox" checked={effects.pointerHighlight} onChange={(event) => setEffect('pointerHighlight', event.target.checked)} /><i /></label></div>
          <div className="setting-row"><div><strong>液态折射</strong><span>SVG 位移</span></div><label className="switch-control"><input aria-label="液态折射" type="checkbox" checked={effects.refraction} onChange={(event) => setEffect('refraction', event.target.checked)} /><i /></label></div>
          <div className="setting-row"><div><strong>背景模糊</strong><span>半透明材质</span></div><label className="switch-control"><input aria-label="背景模糊" type="checkbox" checked={effects.backdropBlur} onChange={(event) => setEffect('backdropBlur', event.target.checked)} /><i /></label></div>
          <div className="setting-row"><div><strong>悬停浮起</strong><span>控件反馈</span></div><label className="switch-control"><input aria-label="悬停浮起" type="checkbox" checked={effects.hoverMotion} onChange={(event) => setEffect('hoverMotion', event.target.checked)} /><i /></label></div>
        </section>
        <section className="settings-section settings-section--data glass-card"><header><Database size={19} /><div><h3>数据源</h3></div></header><div className="setting-row"><div><strong>运行模式</strong><span>{clusters.length} 个集群</span></div><div className="segmented text-segmented">{dataModes.map((item) => <button key={item.value} className={mode === item.value ? 'is-active' : ''} onClick={() => setMode(item.value)}>{item.label}</button>)}</div></div></section>
        <section className="settings-section settings-section--resources glass-card"><header><Rows3 size={19} /><div><h3>资源视图</h3></div></header><div className="setting-row"><div><strong>自动刷新</strong><span>60 秒</span></div><label className="switch-control"><input aria-label="自动刷新" type="checkbox" checked={autoRefresh} onChange={(event) => setAutoRefresh(event.target.checked)} /><i /></label></div><div className="setting-row"><div><strong>每页行数</strong><span>资源表格</span></div><input className="number-input" type="number" min={10} max={200} step={5} value={rows} onChange={(event) => setRows(Number(event.target.value))} /></div></section>
      </div>
    </div>
  );
}
