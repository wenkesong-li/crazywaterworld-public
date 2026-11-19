import * as React from "react"
import { Button } from "../button"
import { Input } from "../input"
import { UsersRound, ShieldCheck, ChevronRight, Plus, X } from "lucide-react"

export function ConsoleUsersDialog() {
  return (<dialog id="console-users-dialog" aria-labelledby="console-users-title">
      <div className="console-users-heading"><div className="console-users-heading-icon"><UsersRound aria-hidden="true" /></div><div><p className="console-eyebrow">后台管理</p><h2 id="console-users-title">用户与游戏账号权限</h2><p className="dim">创建后台用户，分配可访问的游戏账号。</p></div><Button id="console-users-close" type="button" size="icon-sm" variant="ghost" aria-label="关闭后台用户管理"><X aria-hidden="true" /></Button></div>
      <div className="console-users-stats"><div><span>用户总数</span><strong id="console-users-total">—</strong></div><div><span>已启用</span><strong id="console-users-enabled">—</strong></div><div><span>游戏账号</span><strong id="console-users-games">—</strong></div></div>
      <p id="console-users-message" role="status" aria-live="polite" />
      <div className="console-users-layout">
        <aside className="console-users-sidebar">
          <details id="console-user-create-panel" className="console-user-create-panel"><summary><Plus aria-hidden="true" />创建后台用户</summary>
            <form id="console-user-create" className="console-user-create"><label>后台账号<Input id="console-user-create-name" placeholder="输入登录账号" autoComplete="off" maxLength={64} required /></label><label>初始密码<Input id="console-user-create-password" placeholder="至少 4 个字符" type="password" autoComplete="new-password" minLength={4} maxLength={256} required /></label><Button type="submit">创建用户<ChevronRight aria-hidden="true" /></Button></form>
          </details>
          <div className="console-users-list-heading"><span>用户列表</span><label className="console-password-toggle"><input id="console-user-password-visible" type="checkbox" />显示密码</label></div>
          <Input id="console-user-search" type="search" placeholder="搜索后台账号" aria-label="搜索后台用户" />
          <div id="console-users-list" aria-label="后台用户列表" />
        </aside>
        <div className="console-users-detail">
          <div id="console-user-empty" className="console-user-empty"><UsersRound aria-hidden="true" /><h3>选择一个后台用户</h3><p>从左侧选择用户，查看或调整其游戏账号权限。</p></div>
          <div id="console-user-root-note" className="console-user-empty" hidden><ShieldCheck aria-hidden="true" /><h3>超级管理员</h3><p>可访问和管理全部游戏账号，始终保留全局调配权限。</p><span className="console-user-status">受保护账号</span></div>
          <form id="console-user-editor" hidden>
            <div className="console-user-detail-heading"><div><p className="console-eyebrow">当前用户</p><h3 id="console-user-edit-name" /></div><label className="console-user-login-toggle"><input id="console-user-enabled" type="checkbox" />允许登录</label></div>
            <div className="console-user-field"><label htmlFor="console-user-reset-password">重置密码<span className="dim">可选</span></label><Input id="console-user-reset-password" placeholder="留空保持原密码" type="password" autoComplete="new-password" minLength={4} maxLength={256} /></div>
            <div className="console-assign-heading"><div><h4>可访问的游戏账号 <span id="console-assigned-count" /></h4><p className="dim">同一账号可共享给多个用户，配置与运行状态共享。</p></div><div className="bar"><Button id="console-assign-all" size="sm" type="button" variant="ghost">全选</Button><Button id="console-assign-none" size="sm" type="button" variant="ghost">清空</Button></div></div>
            <fieldset id="console-user-assignments" aria-label="分配游戏账号" />
            <div className="console-user-editor-footer"><div><Button id="console-user-delete" type="button" variant="ghost" className="text-destructive hover:text-destructive">删除用户</Button><span className="dim">更改后，该用户需要重新登录。</span></div><Button type="submit">保存权限</Button></div>
          </form>
        </div>
      </div>
    </dialog>)
}
