// 在样式加载前恢复主题，避免刷新时短暂显示白天配色。
(() => {
  const storageKey = 'cw-theme';
  const appearanceKey = 'cw-appearance';
  const palettes = {
    classic: null,
    ocean: ['#126577', '#81d8e3'],
    forest: ['#24664a', '#8cdbab'],
    violet: ['#6a46a0', '#c8afff'],
    amber: ['#a0581d', '#ffc88e'],
  };

  function readAppearance() {
    let saved;
    try { saved = JSON.parse(localStorage.getItem(appearanceKey)); } catch {}
    const color = /^#[0-9a-f]{6}$/i.test(saved?.color ?? '') ? saved.color : '#126577';
    const palette = Object.hasOwn(palettes, saved?.palette) || saved?.palette === 'custom' ? saved.palette : 'classic';
    return { palette, color, motion: saved?.motion === 'off' ? 'off' : 'system' };
  }

  let appearance = readAppearance();

  function foregroundFor(color) {
    const rgb = [1, 3, 5].map(index => parseInt(color.slice(index, index + 2), 16) / 255);
    const [r, g, b] = rgb.map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    return .2126 * r + .7152 * g + .0722 * b > .179 ? '#000000' : '#ffffff';
  }
  const labels = { system: '跟随系统', light: '白天', dark: '黑夜' };
  const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
  let renderControls = () => {};

  function readMode() {
    try {
      const saved = localStorage.getItem(storageKey);
      if (Object.hasOwn(labels, saved)) return saved;
    } catch {}
    return 'system';
  }

  let mode = readMode();

  function applyTheme() {
    const dark = mode === 'dark' || (mode === 'system' && systemTheme.matches);
    const root = document.documentElement;
    root.dataset.theme = dark ? 'dark' : 'light';
    root.dataset.palette = appearance.palette;
    root.dataset.motion = appearance.motion;
    const accent = appearance.palette === 'custom' ? appearance.color : palettes[appearance.palette]?.[dark ? 1 : 0];
    if (accent) {
      root.style.setProperty('--appearance-accent', accent);
      root.style.setProperty('--appearance-ink', foregroundFor(accent));
    } else {
      root.style.removeProperty('--appearance-accent');
      root.style.removeProperty('--appearance-ink');
    }
    document.querySelector('meta[name="theme-color"]').content = dark ? '#0a0a0a' : '#ffffff';
    renderControls();
  }

  applyTheme();
  systemTheme.addEventListener('change', () => {
    if (mode === 'system') applyTheme();
  });
  window.addEventListener('storage', event => {
    if (![storageKey, appearanceKey, null].includes(event.key)) return;
    mode = readMode();
    appearance = readAppearance();
    applyTheme();
  });

  document.addEventListener('DOMContentLoaded', () => {
    const picker = document.getElementById('theme-picker');
    const trigger = document.getElementById('theme-trigger');
    const menu = document.getElementById('theme-menu');
    if (!picker || !trigger || !menu) return;
    const options = Array.from(menu.querySelectorAll('[data-theme-option]'));
    const appearanceOpen = document.getElementById('theme-appearance-open');
    const appearanceDialog = document.getElementById('theme-appearance-dialog');
    const accentInput = document.getElementById('theme-accent-color');
    const motion = document.getElementById('theme-motion');
    const swatches = [...appearanceDialog.querySelectorAll('[data-appearance-palette]')];

    function setAppearance(patch) {
      appearance = { ...appearance, ...patch };
      try { localStorage.setItem(appearanceKey, JSON.stringify(appearance)); } catch {}
      applyTheme();
    }

    appearanceOpen.onclick = () => {
      closeMenu();
      appearanceDialog.showModal();
    };
    document.getElementById('theme-appearance-close').onclick = () => appearanceDialog.close();
    appearanceDialog.addEventListener('close', () => trigger.focus());
    document.getElementById('theme-appearance-reset').onclick = () => setAppearance({ palette: 'classic', color: '#126577', motion: 'system' });
    for (const button of swatches) button.onclick = () => setAppearance({ palette: button.dataset.appearancePalette });
    accentInput.oninput = () => setAppearance({ color: accentInput.value, palette: 'custom' });
    motion.onchange = () => setAppearance({ motion: motion.value });

    renderControls = () => {
      for (const button of swatches) button.setAttribute('aria-pressed', String(appearance.palette === button.dataset.appearancePalette));
      if (accentInput.value !== appearance.color) accentInput.value = appearance.color;
      motion.value = appearance.motion;
      const title = '切换主题，当前为' + labels[mode];
      trigger.title = title;
      trigger.setAttribute('aria-label', title);
      for (const icon of trigger.querySelectorAll('[data-theme-icon]')) {
        icon.hidden = icon.dataset.themeIcon !== mode;
      }
      for (const option of options) {
        const selected = option.dataset.themeOption === mode;
        option.setAttribute('aria-checked', String(selected));
        option.querySelector('[data-theme-check]').hidden = !selected;
      }
    };
    renderControls();

    function closeMenu(restoreFocus = false) {
      menu.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      if (restoreFocus) trigger.focus();
    }

    function openMenu(option = options.find(item => item.dataset.themeOption === mode)) {
      menu.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      option.focus();
    }

    trigger.addEventListener('click', () => {
      if (menu.hidden) openMenu();
      else closeMenu();
    });
    trigger.addEventListener('keydown', event => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      openMenu(event.key === 'ArrowUp' ? options.at(-1) : options[0]);
    });
    for (const option of options) {
      option.addEventListener('click', () => {
        mode = option.dataset.themeOption;
        try { localStorage.setItem(storageKey, mode); } catch {}
        applyTheme();
        closeMenu(true);
      });
    }
    menu.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMenu(true);
        return;
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const items = [...options, appearanceOpen];
      const index = items.indexOf(document.activeElement);
      let next = index + (event.key === 'ArrowUp' ? -1 : 1);
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = items.length - 1;
      items[(next + items.length) % items.length].focus();
    });
    document.addEventListener('pointerdown', event => {
      if (!picker.contains(event.target)) closeMenu();
    });
    picker.addEventListener('focusout', event => {
      if (!picker.contains(event.relatedTarget)) closeMenu();
    });
  }, { once: true });
})();
