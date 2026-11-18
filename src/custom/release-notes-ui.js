async function initReleaseNotes() {
  const dialog = document.createElement('dialog');
  dialog.id = 'release-notes-dialog';
  dialog.setAttribute('aria-labelledby', 'release-notes-title');
  const heading = document.createElement('h2');
  heading.id = 'release-notes-title';
  const content = document.createElement('div');
  content.className = 'release-notes-content';
  const message = document.createElement('p');
  message.className = 'release-notes-message';
  message.setAttribute('role', 'status');
  const footer = document.createElement('div');
  footer.className = 'release-notes-footer';
  const historyButton = document.createElement('button');
  historyButton.type = 'button';
  historyButton.textContent = '查看全部更新';
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.textContent = '我知道了';
  footer.append(historyButton, closeButton);
  dialog.append(heading, content, message, footer);
  document.body.append(dialog);
  const entry = document.createElement('button');
  entry.id = 'release-notes-open';
  entry.type = 'button';
  entry.textContent = '更新记录';
  entry.setAttribute('aria-haspopup', 'dialog');
  entry.setAttribute('aria-controls', dialog.id);
  document.querySelector('.account-page-actions').prepend(entry);
  let data = null;
  let saving = false;
  const render = latestOnly => {
    heading.textContent = latestOnly ? '本次更新' : '更新记录';
    content.replaceChildren();
    historyButton.hidden = !latestOnly;
    for (const release of latestOnly ? data.releases.slice(0, 1) : data.releases) {
      const article = document.createElement('article');
      const title = document.createElement('h3');
      title.textContent = release.title;
      const meta = document.createElement('p');
      meta.className = 'release-notes-meta';
      meta.textContent = release.date + ' · ' + release.version;
      const list = document.createElement('ul');
      for (const item of release.items) {
        const row = document.createElement('li');
        row.textContent = item;
        list.append(row);
      }
      article.append(title, meta, list);
      content.append(article);
    }
  };
  const load = async () => { data = await call('/api/updates'); };
  const close = async () => {
    if (saving) return;
    saving = true;
    closeButton.disabled = true;
    message.textContent = '';
    try {
      if (data?.unread) {
        await call('/api/updates/read', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: data.latestVersion }) });
        data.unread = false;
      }
      dialog.close();
    } catch (error) {
      message.textContent = '已读状态保存失败，请重试：' + error.message;
    } finally {
      saving = false;
      closeButton.disabled = false;
    }
  };
  closeButton.onclick = () => { void close(); };
  dialog.oncancel = event => { event.preventDefault(); void close(); };
  historyButton.onclick = () => render(false);
  entry.onclick = async () => {
    entry.disabled = true;
    try {
      await load();
      render(false);
      message.textContent = '';
      dialog.showModal();
    } catch (error) { reportError(error); }
    finally { entry.disabled = false; }
  };
  try {
    await load();
    if (data.unread && !document.querySelector('dialog[open]')) {
      render(true);
      dialog.showModal();
    }
  } catch (error) { reportError(error); }
}
