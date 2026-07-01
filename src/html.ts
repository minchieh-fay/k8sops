export function renderPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>K8s Ops Console</title>
  <link rel="stylesheet" href="/assets/styles.css" />
</head>
<body>
  <div class="page-shell">
    <div class="page-glow page-glow-left"></div>
    <div class="page-glow page-glow-right"></div>
    <aside class="sidebar">
      <div class="sidebar-head">
        <div>
          <p class="eyebrow">K8s Ops</p>
          <h1>运维会话</h1>
        </div>
        <button id="new-session-btn" class="primary-btn">新建会话</button>
      </div>
      <div id="session-list" class="session-list"></div>
    </aside>
    <main class="main-panel">
      <section id="setup-view" class="setup-view card">
        <div class="setup-shell">
          <div class="setup-copy">
            <p class="eyebrow">Step 1</p>
            <h2>先拿到这次集群的 kubeconfig</h2>
            <p class="muted">每次新建会话都先完成这一步。下面两张图就是从 Rancher 进入查看和复制 kubeconfig 的路径，复制后粘贴到右侧即可。</p>
            <div class="setup-steps">
              <article class="setup-step-card">
                <div class="setup-step-head">
                  <span class="step-index">1</span>
                  <strong>进入集群页面</strong>
                </div>
                <p class="muted">在 Rancher 首页进入对应集群，点击右上角的 “kubeconfig 文件” 按钮。</p>
                <img src="/assets/images/kubeconfig-button.png" alt="进入 kubeconfig 页面" class="setup-shot" />
              </article>
              <article class="setup-step-card">
                <div class="setup-step-head">
                  <span class="step-index">2</span>
                  <strong>复制配置内容</strong>
                </div>
                <p class="muted">在弹出的页面中点击底部“复制到剪贴板”，把完整内容粘贴到右侧输入框。</p>
                <img src="/assets/images/copy-kubeconfig.png" alt="复制 kubeconfig 内容" class="setup-shot" />
              </article>
            </div>
          </div>
          <div class="setup-form">
            <div class="card-head">
              <div>
                <h3>绑定集群配置</h3>
                <p class="muted">创建完成后会直接进入用户与 Codex 的交互界面。</p>
              </div>
              <button
                type="button"
                class="help-dot"
                data-tip='打开 rancher 首页，meeting -> 集群，点击右上角 "kubeconfig 文件" 的按钮，点击最下方“复制到剪贴板”，之后在此处粘贴。'
              >kubeconfig 帮助</button>
            </div>
            <label class="field">
              <span>kubeconfig</span>
              <textarea id="kubeconfig-input" rows="10" placeholder="在这里粘贴 kubeconfig。点击下一步后才会真正生成会话。"></textarea>
              <small id="kubeconfig-hint" class="hint">等待校验</small>
            </label>
            <div class="action-row">
              <span id="setup-note" class="muted"></span>
              <button id="setup-next-btn" class="primary-btn">下一步</button>
            </div>
          </div>
        </div>
      </section>

      <section id="chat-view" class="chat-view">
        <section class="hero card">
          <div>
            <p class="eyebrow">Codex + kubectl</p>
            <h2 id="session-title">加载中</h2>
            <p id="session-meta" class="muted"></p>
          </div>
          <div id="session-status" class="status-badge">draft</div>
        </section>

        <section class="card form-card">
          <div class="card-head">
            <div>
              <h3>问题输入</h3>
              <p class="muted">当前会话的 kubeconfig 已固定，下面只需要继续描述问题和上传截图。</p>
            </div>
          </div>
          <div class="field-row">
            <label class="field">
              <span>问题描述</span>
              <textarea id="prompt-input" rows="8" placeholder="例如：某个 deployment 无法拉起，帮我排查原因。"></textarea>
            </label>
          </div>
          <div class="field-row">
            <label class="upload-field">
              <span>错误截图</span>
              <input id="image-input" type="file" accept="image/*" multiple />
            </label>
            <div id="image-preview" class="image-preview"></div>
          </div>
          <div class="action-row">
            <span id="submit-note" class="muted"></span>
            <button id="submit-btn" class="primary-btn">提交给 Codex</button>
          </div>
        </section>

        <section class="content-grid">
          <section class="card">
            <div class="card-head">
              <h3>对话记录</h3>
            </div>
            <div id="turn-list" class="turn-list"></div>
          </section>
          <section class="card">
            <div class="card-head">
              <h3>执行轨迹</h3>
            </div>
            <div id="event-list" class="event-list"></div>
          </section>
        </section>
      </section>
    </main>
  </div>
  <script type="module" src="/assets/app.js"></script>
</body>
</html>`;
}
