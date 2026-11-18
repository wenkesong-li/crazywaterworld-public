async function initUpdate() {
  const entry = document.getElementById('update-open');
  if (!entry) return;

  const dialog = document.createElement('dialog');
  dialog.id = 'update-dialog';
  dialog.setAttribute('aria-labelledby', 'update-title');
  const heading = document.createElement('h2');
  heading.id = 'update-title';
  heading.textContent = '检查更新';
  const body = document.createElement('div');
  body.className = 'update-body';
  const footer = document.createElement('div');
  footer.className = 'update-footer';
  const cancelButton = document.createElement('button');
  cancelButton.type = 'button';
  cancelButton.textContent = '关闭';
  const confirmButton = document.createElement('button');
  confirmButton.type = 'button';
  confirmButton.textContent = '确认更新';
  footer.append(confirmButton, cancelButton);
  dialog.append(heading, body, footer);
  document.body.append(dialog);

  let pollTimer = null;
  const stopPolling = () => { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } };
  const close = () => { stopPolling(); dialog.close(); };

  cancelButton.onclick = close;
  dialog.oncancel = event => { event.preventDefault(); close(); };

  const short = sha => sha ? sha.slice(0, 8) : '';
  const setBody = node => { body.replaceChildren(node); };
  const paragraph = (text, className) => { const p = document.createElement('p'); if (className) p.className = className; p.textContent = text; return p; };

  function showResult(result) {
    if (!result.available) {
      setBody(paragraph(result.reason, 'update-hint'));
      confirmButton.hidden = true;
      return;
    }
    if (result.upToDate) {
      setBody(paragraph('已是最新版本（当前 ' + short(result.current) + '）。'));
      confirmButton.hidden = true;
      return;
    }
    if (result.diverged) {
      const wrap = document.createElement('div');
      wrap.append(paragraph('本地代码与上游已分叉，无法一键快进更新。'));
      wrap.append(paragraph('本地包含上游没有的自有提交，同时上游也有新提交。请手动合并上游改动，或重新克隆最新版本。', 'update-hint'));
      setBody(wrap);
      confirmButton.hidden = true;
      return;
    }
    const wrap = document.createElement('div');
    wrap.append(paragraph('发现新版本：' + short(result.current) + ' → ' + short(result.remote)));
    if (result.commits?.length) {
      const label = document.createElement('p');
      label.className = 'update-hint';
      label.textContent = '更新内容：';
      wrap.append(label);
      const list = document.createElement('ul');
      list.className = 'update-commits';
      for (const line of result.commits) {
        const item = document.createElement('li');
        item.textContent = line.replace(/^[0-9a-f]{7,40}\s+/, '');
        list.append(item);
      }
      wrap.append(list);
    }
    wrap.append(paragraph('更新只拉取代码；账号、配置和运行记录保存在 data/ 目录，不受影响。', 'update-hint'));
    setBody(wrap);
    confirmButton.hidden = false;
  }

  function showProgress(state) {
    const wrap = document.createElement('div');
    wrap.append(paragraph(state.detail || '正在更新…'));
    const bar = document.createElement('div');
    bar.className = 'update-progress';
    const fill = document.createElement('div');
    fill.className = 'update-progress-fill';
    fill.style.width = Math.max(0, Math.min(100, state.percent)) + '%';
    bar.append(fill);
    wrap.append(bar);
    wrap.append(paragraph(Math.max(0, Math.min(100, state.percent)) + '%', 'update-hint'));
    setBody(wrap);
  }

  function showDone(state) {
    const wrap = document.createElement('div');
    wrap.append(paragraph('✅ 更新完成，已升级到 ' + short(state.version) + '。'));
    wrap.append(paragraph('请关闭当前窗口（直接关闭终端窗口，或按 Ctrl+C / Cmd+Q），然后重新双击 start.cmd / start.command 启动最新版本。', 'update-hint'));
    wrap.append(paragraph('账号、配置和运行记录保存在 data/ 目录，重新启动后不受影响。', 'update-hint'));
    setBody(wrap);
    confirmButton.hidden = true;
  }

  function poll() {
    stopPolling();
    pollTimer = setInterval(async () => {
      try {
        const state = await call('/api/update/progress');
        if (state.finished) {
          stopPolling();
          if (state.error) {
            setBody(paragraph('更新失败：' + state.error, 'update-hint'));
            confirmButton.hidden = true;
          } else if (state.done) showDone(state);
          return;
        }
        showProgress(state);
      } catch (error) { stopPolling(); reportError(error); }
    }, 800);
  }

  confirmButton.onclick = async () => {
    confirmButton.disabled = true;
    try {
      const accepted = await call('/api/update/apply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true }) });
      if (!accepted.ok) { setBody(paragraph(accepted.error || '无法开始更新。', 'update-hint')); confirmButton.hidden = true; return; }
      confirmButton.hidden = true;
      showProgress({ percent: 0, detail: '准备更新…' });
      poll();
    } catch (error) {
      confirmButton.hidden = true;
      reportError(error);
    } finally {
      confirmButton.disabled = false;
    }
  };

  entry.onclick = async () => {
    entry.disabled = true;
    setBody(paragraph('正在检查更新…'));
    confirmButton.hidden = true;
    dialog.showModal();
    try {
      showResult(await call('/api/update/check'));
    } catch (error) {
      setBody(paragraph('检查更新失败，请稍后重试。', 'update-hint'));
      reportError(error);
    } finally {
      entry.disabled = false;
    }
  };
}
