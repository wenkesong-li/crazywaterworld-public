#!/bin/bash
set -Eeuo pipefail
umask 077
test "$#" = 1 || { echo 'Usage: auto-sync-server.sh /private/config.env'; exit 2; }
source "$1"
: "${CW_SYNC_ROOT:?}" "${CW_SYNC_APP:?}" "${CW_SYNC_RUNTIME:?}" "${CW_SYNC_SERVICE:?}"
: "${CW_SYNC_ORIGIN:?}" "${CW_SYNC_UPSTREAM:?}" "${CW_SYNC_GIT_SSH:?}"
: "${CW_SYNC_UID:?}" "${CW_SYNC_GID:?}" "${CW_SYNC_HEALTH_URL:?}"
branch=${CW_SYNC_BRANCH:-main}
upstream_branch=${CW_SYNC_UPSTREAM_BRANCH:-main}
app=$CW_SYNC_APP
runtime=$CW_SYNC_RUNTIME
repository=$CW_SYNC_ROOT/repository
mkdir -p "$CW_SYNC_ROOT/logs" "$CW_SYNC_ROOT/stages"
exec 9>"$CW_SYNC_ROOT/run.lock"
flock -n 9 || exit 0
run_id=$(date +%Y%m%d-%H%M%S)-$$
exec >>"$CW_SYNC_ROOT/logs/$run_id.log" 2>&1
export TZ=Asia/Shanghai GIT_TERMINAL_PROMPT=0 GIT_SSH="$CW_SYNC_GIT_SSH"
printf '%s Checking origin and upstream\n' "$(date -Iseconds)"
stage=$CW_SYNC_ROOT/stages/$run_id
mounted=0
stopped=0
backup_ready=0
backup=
fail() {
  code=${1:-$?}
  trap - ERR TERM INT
  set +e
  if test "$stopped" = 1; then
    systemctl stop "$CW_SYNC_SERVICE" || true
    mkdir -p "$backup/failed"
    for name in src tools node_modules package.json package-lock.json release-info.json downloads; do
      if test -e "$backup/program/$name"; then
        if test -e "$app/$name"; then mv "$app/$name" "$backup/failed/$name"; fi
        mv "$backup/program/$name" "$app/$name"
      fi
    done
    if test "$backup_ready" = 1; then tar -xzf "$backup/data.tar.gz" -C "$app"; fi
    systemctl start "$CW_SYNC_SERVICE" || true
  fi
  if test "$mounted" = 1; then if umount "$runtime/stage"; then mounted=0; fi; fi
  printf '%s Failed with status %s; current service preserved or restored\n' "$(date -Iseconds)" "$code"
  exit "$code"
}
trap fail ERR
trap 'fail 143' TERM
trap 'fail 130' INT
finish() {
  if test "$mounted" = 1; then
    if umount "$runtime/stage"; then mounted=0; fi
  fi
  if test "$mounted" = 0 && test -d "$stage"; then
    python - "$CW_SYNC_ROOT" "$stage" <<'PY'
import os,sys,shutil
root,stage=sys.argv[1:]
if os.path.dirname(stage)==os.path.join(root,'stages') and not os.path.islink(stage):shutil.rmtree(stage)
PY
  fi
}
trap finish EXIT
test -f "$repository/.git/auto-sync-owned"
cd "$repository"
git merge --abort 2>/dev/null || true
git reset --hard "refs/remotes/origin/$branch"
timeout 180 git fetch origin "+refs/heads/$branch:refs/remotes/origin/$branch"
timeout 180 git fetch upstream "+refs/heads/$upstream_branch:refs/remotes/upstream/$upstream_branch"
git reset --hard "refs/remotes/origin/$branch"
origin_head=$(git rev-parse HEAD)
deployed_head=$(python - "$app/release-info.json" <<'PY'
import json,sys
print(json.load(open(sys.argv[1]))['commit'])
PY
)
git cat-file -e "$deployed_head^{commit}"
git merge-base --is-ancestor "$deployed_head" HEAD
if ! git merge --no-commit --no-edit "refs/remotes/upstream/$upstream_branch"; then
  python - <<'PY'
import subprocess,sys
names=subprocess.check_output(['git','diff','--name-only','--diff-filter=U']).decode('utf8').splitlines()
unsupported=[name for name in names if not name.endswith('.md') and not name.startswith('src/ui/dist/')]
if unsupported:
 print('Manual conflict resolution required: '+', '.join(unsupported));sys.exit(1)
for name in names:
 subprocess.check_call(['git','checkout','HEAD','--',name])
PY
fi
python - <<'PY'
import subprocess
names=subprocess.check_output(['git','diff','--cached','--name-only']).decode('utf8').splitlines()
for name in names:
 if name.endswith('.md'):
  exists=subprocess.call(['git','cat-file','-e','HEAD:'+name],stdout=open('/dev/null','w'),stderr=subprocess.STDOUT)==0
  subprocess.check_call(['git','checkout','HEAD','--',name] if exists else ['git','rm','-f','--',name])
PY
if test "$(git rev-parse HEAD)" = "$deployed_head" && test -z "$(git status --porcelain)" && ! test -f .git/MERGE_HEAD; then
  echo 'Already deployed; no changes.'
  exit 0
fi
mkdir -p "$stage" "$runtime/stage"
git archive "$(git write-tree)" | tar -x -C "$stage"
chown -R "$CW_SYNC_UID:$CW_SYNC_GID" "$stage"
if mountpoint -q "$runtime/stage"; then echo 'Runtime stage mount is already in use'; exit 1; fi
mount --bind "$stage" "$runtime/stage"
mounted=1
timeout 1200 chroot --userspec="$CW_SYNC_UID:$CW_SYNC_GID" "$runtime" /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/tmp/cw-auto-sync TMPDIR=/tmp LANG=C.UTF-8 CW_RESOURCE_AUTO_UPDATE=0 /bin/sh -c 'cd /stage && npm ci --include=dev --no-audit --no-fund && npm run build:ui && npm run typecheck && npm run check:ui && npm run test:auth && npm run test:accounts && npm run test:client && npm prune --omit=dev --ignore-scripts --no-audit --no-fund'
rsync -a --delete "$stage/src/ui/dist/" "$repository/src/ui/dist/"
git add -A -- src/ui/dist
git diff --cached --check
python - <<'PY'
import subprocess,sys
names=subprocess.check_output(['git','diff','--cached','--name-only']).decode('utf8').splitlines()
for name in names:
 if name.lower().endswith(('.md','.sql')) or name.startswith(('data/','deploy/','output/')) or name.endswith(('.env','.key')):
  raise SystemExit('Refusing private or excluded path: '+name)
patch=subprocess.check_output(['git','diff','--cached','--unified=0']).decode('utf8','replace')
if '-----BEGIN PRIVATE KEY-----' in patch or '-----BEGIN RSA PRIVATE KEY-----' in patch or '-----BEGIN OPENSSH PRIVATE KEY-----' in patch:
 raise SystemExit('Refusing private key material')
PY
if test -f .git/MERGE_HEAD; then git commit -m '同步主线更新';
elif ! git diff --cached --quiet; then git commit -m '更新界面构建产物'; fi
target=$(git rev-parse HEAD)
remote_head=$(timeout 60 git ls-remote origin "refs/heads/$branch" | cut -f1)
test "$remote_head" = "$origin_head" || { echo 'Origin changed during build; retry on next run'; exit 1; }
timeout 180 git push origin "HEAD:refs/heads/$branch"
python - "$stage/release-info.json" "$target" <<'PY'
import json,sys
json.dump({'commit':sys.argv[2]},open(sys.argv[1],'w'))
PY
mkdir -p "$stage/program-downloads"
if test -d "$app/downloads"; then cp -a "$app/downloads/." "$stage/program-downloads/"; fi
if test -d "$stage/downloads"; then cp -a "$stage/downloads/." "$stage/program-downloads/"; fi
python - "$stage/program-downloads" <<'PY'
import os,sys
for name in ('CrazyWaterWorldCapture.exe','wechat-capture-assistant.zip'):
 file=os.path.join(sys.argv[1],name)
 if os.path.isfile(file):os.unlink(file)
PY
mv "$stage/program-downloads" "$stage/ready-downloads"
chown -R "$CW_SYNC_UID:$CW_SYNC_GID" "$stage"
backup=$CW_SYNC_ROOT/backups/auto-$run_id
mkdir -p "$backup/program"
systemctl stop "$CW_SYNC_SERVICE"
stopped=1
tar -czf "$backup/data.tar.gz" --exclude=data/chromium --exclude=data/playwright-browsers -C "$app" data
backup_ready=1
sha256sum "$app/deploy/production.env" "$app/protocol/_src_chunks_.wxapkg" > "$backup/preserved.sha256"
for name in src tools node_modules package.json package-lock.json release-info.json downloads; do
  if test -e "$app/$name"; then mv "$app/$name" "$backup/program/$name"; fi
  if test "$name" = downloads; then mv "$stage/ready-downloads" "$app/downloads";
  else mv "$stage/$name" "$app/$name"; fi
done
systemctl start "$CW_SYNC_SERVICE"
ready=0
attempt=0
while test "$attempt" -lt 30; do
  attempt=$((attempt+1))
  if curl -fsS --max-time 3 "$CW_SYNC_HEALTH_URL" -o /dev/null; then ready=1; break; fi
  sleep 1
done
test "$ready" = 1
systemctl is-active "$CW_SYNC_SERVICE"
sha256sum -c "$backup/preserved.sha256"
stopped=0
umount "$runtime/stage"
mounted=0
printf '%s Deployed %s; update history published\n' "$(date -Iseconds)" "$target"
python - "$CW_SYNC_ROOT" "$stage" "${CW_SYNC_KEEP_BACKUPS:-5}" <<'PY'
import os,sys,shutil,glob
root,stage,keep=sys.argv[1:];keep=max(2,int(keep))
if os.path.dirname(stage)==os.path.join(root,'stages') and not os.path.islink(stage):shutil.rmtree(stage)
backups=sorted(glob.glob(os.path.join(root,'backups','auto-*')))
for entry in backups[:-keep]:
 if os.path.isdir(entry) and not os.path.islink(entry):shutil.rmtree(entry)
logs=sorted(glob.glob(os.path.join(root,'logs','*.log')))
for entry in logs[:-120]:os.unlink(entry)
PY
