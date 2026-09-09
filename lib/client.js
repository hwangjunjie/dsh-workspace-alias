/*
 * dsh-workspace-alias — client half (web settings UI section).
 *
 * HAND-WRITTEN, NOT COMPILED. This file must stay in the DSH client-module
 * bundle format: the host's client-modules registry serves the file resolved
 * by exports["./client"] verbatim as a browser script, and the browser module
 * system materializes the factory through window.__ModuleLoader__. The host
 * discovers this half from package.json `dsh.client` (platform "web") and
 * includes it in the __DSH_BOOT__ entry graph (see
 * @deepseek-ai/dsh-client-modules lib/index.js).
 *
 * Purity rules (runtime-enforced, mirrors the build-time bundle purity gate):
 * - The only value imports allowed here are seed modules ("react").
 * - Everything DSH-related is reached through cordis services on ctx:
 *     slots         -> register the "settings.section" slot
 *     settingsScope -> bind({ namespace }) read/write face for our namespace
 *   Writes ride the settingsScope's owned write path (revision-fenced);
 *   we never import @deepseek-ai/* client packages as values.
 *
 * UI model: the section is a draft editor. The host stays the fact source —
 * a draft is created on the first local edit and "保存更改" commits both
 * fields through one atomic mutate; 放弃 re-syncs from the host snapshot.
 * The JSON file (workspace-alias.json) remains the single true source; the
 * host-side settings bridge (src/settings.ts) mirrors writes into it and
 * pushes external file changes back into this namespace.
 */

window.__ModuleLoader__.load({
  id: "dsh-workspace-alias",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var react = require("react");

    var NAMESPACE = "workspace-alias";

    // ---- tiny element helpers (no JSX runtime dependency) -----------------

    function el(type, props) {
      var children = Array.prototype.slice.call(arguments, 2);
      var all = props ? Object.assign({}, props) : {};
      var flat = [];
      for (var i = 0; i < children.length; i++) {
        var c = children[i];
        if (Array.isArray(c)) flat = flat.concat(c);
        else flat.push(c);
      }
      // Only attach `children` when there is at least one child. Assigning
      // `children: []` unconditionally makes every childless call — the two
      // `el("input", …)` rows — crash in react-dom's COMMIT phase with
      // "input is a void element tag and must neither have children". A commit
      // crash is invisible to this component's render-phase try/catch: the
      // slot boundary abdicates the entry and the settings pane renders an
      // empty `data-slot-error` div (blank page, nav row still present).
      if (flat.length === 1) all.children = flat[0];
      else if (flat.length > 1) all.children = flat;
      return react.createElement(type, all);
    }

    var STYLES = {
      root: { maxWidth: 640, display: "flex", flexDirection: "column", gap: 12, fontSize: 13, lineHeight: 1.5 },
      muted: { color: "rgba(127,127,127,0.9)", fontSize: 12 },
      card: {
        border: "1px solid rgba(127,127,127,0.35)",
        borderRadius: 10,
        padding: "10px 12px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      },
      row: { display: "flex", gap: 8, alignItems: "center" },
      input: {
        flex: 1,
        minWidth: 0,
        padding: "5px 8px",
        border: "1px solid rgba(127,127,127,0.4)",
        borderRadius: 8,
        background: "transparent",
        color: "inherit",
        font: "inherit",
      },
      button: {
        padding: "4px 10px",
        border: "1px solid rgba(127,127,127,0.4)",
        borderRadius: 8,
        background: "transparent",
        color: "inherit",
        cursor: "pointer",
        font: "inherit",
      },
      danger: { color: "#e06c6c" },
      primary: {
        border: "1px solid rgba(127,127,127,0.4)",
        borderRadius: 8,
        background: "rgba(127,127,127,0.15)",
        color: "inherit",
        cursor: "pointer",
        font: "inherit",
        padding: "4px 14px",
      },
      label: { display: "flex", gap: 6, alignItems: "center", cursor: "pointer" },
    };

    // ---- state helpers -----------------------------------------------------

    function cloneGroups(groups) {
      return (groups || []).map(function (g) { return g.slice(); });
    }

    /** Trim, drop empty members and empty groups — the host skips those anyway. */
    function cleanGroups(groups) {
      var out = [];
      for (var i = 0; i < groups.length; i++) {
        var members = [];
        for (var j = 0; j < groups[i].length; j++) {
          var p = String(groups[i][j] == null ? "" : groups[i][j]).trim();
          if (p !== "") members.push(p);
        }
        if (members.length >= 1) out.push(members);
      }
      return out;
    }

    // ---- the section component ---------------------------------------------

    /**
     * Rendered into the settings modal when our nav row is active. Slot props
     * carry `close`; we do not need it (the shell owns dismissal).
     */
    function makeSectionComponent(controller) {
      function WorkspaceAliasSection() {
        try {
          return renderSectionBody(controller);
        } catch (error) {
          return el("div", { style: STYLES.root },
            el("div", { style: STYLES.danger },
              "设置面板渲染异常: " + (error && error.message ? error.message : String(error))));
        }
      }
      return WorkspaceAliasSection;
    }

    function renderSectionBody(controller) {
        var snap = react.useSyncExternalStore(
          function (listener) { return controller.subscribe(listener); },
          function () { return controller.getSnapshot(); },
        );

        // `draft === null` means pristine: display the host snapshot as-is.
        var draftState = react.useState(null); // { autoAttach: boolean, groups: string[][] }
        var draft = draftState[0];
        var setDraft = draftState[1];

        var savingState = react.useState(false);
        var saving = savingState[0];
        var setSaving = savingState[1];

        var rev = snap.revision;
        react.useEffect(
          function () { setDraft(null); },
          [rev],
        );

        if (snap.status !== "ready" || !snap.value) {
          // Diagnostic build: surface the raw scope state so a stuck load is
          // distinguishable from an absent namespace without devtools.
          var detail =
            "status=" + String(snap.status) +
            " revision=" + String(snap.revision) +
            " writable=" + String(snap.writable);
          var hint =
            snap.status === "loading"
              ? "正在读取别名配置…（长时间停留即为异常）"
              : "别名设置暂不可用（设置服务中未发现 workspace-alias 命名空间）。";
          return el("div", { style: STYLES.root },
            el("div", { style: STYLES.muted }, hint),
            el("div", { style: STYLES.muted }, "诊断: " + detail),
            el("div", { style: STYLES.muted }, "snapshot: " + JSON.stringify(snap).slice(0, 300)));
        }

        var value = snap.value;
        var view = draft || {
          autoAttach: value.autoAttach === true,
          groups: cloneGroups(value.groups),
        };

        var editable = snap.writable !== false && !saving;

        function update(next) {
          setDraft({ autoAttach: next.autoAttach === true, groups: next.groups });
        }

        function setGroup(index, members) {
          var groups = cloneGroups(view.groups);
          groups[index] = members;
          update({ autoAttach: view.autoAttach, groups: groups });
        }

        function save() {
          var ops = [
            { op: "set", path: ["autoAttach"], value: view.autoAttach === true },
            { op: "set", path: ["groups"], value: cleanGroups(view.groups) },
          ];
          setSaving(true);
          void Promise.resolve(controller.mutate(ops)).then(
            function () { setSaving(false); setDraft(null); },
            function () { setSaving(false); },
          );
        }

        // ---- tree ------------------------------------------------------------

        var groupCards = view.groups.map(function (members, gi) {
          var memberRows = members.map(function (path, pi) {
            return el("div", { style: STYLES.row, key: "p" + pi },
              el("input", {
                style: STYLES.input,
                value: path,
                readOnly: !editable,
                spellCheck: false,
                onChange: function (event) {
                  var next = members.slice();
                  next[pi] = event.target.value;
                  setGroup(gi, next);
                },
              }),
              el("button", {
                style: Object.assign({}, STYLES.button, STYLES.danger),
                title: "删除该路径",
                disabled: !editable,
                onClick: function () {
                  var next = members.slice();
                  next.splice(pi, 1);
                  if (next.length === 0) {
                    var rest = cloneGroups(view.groups);
                    rest.splice(gi, 1);
                    update({ autoAttach: view.autoAttach, groups: rest });
                  } else setGroup(gi, next);
                },
              }, "移除"));
          });
          return el("div", { style: STYLES.card, key: "g" + gi },
            el("div", { style: STYLES.row },
              el("strong", null, "别名组 " + (gi + 1)),
              el("span", { style: STYLES.muted }, "组内路径指向不同机器上的同一项目目录"),
              el("span", { style: { flex: 1 } }),
              el("button", {
                style: Object.assign({}, STYLES.button, STYLES.danger),
                disabled: !editable,
                onClick: function () {
                  var rest = cloneGroups(view.groups);
                  rest.splice(gi, 1);
                  update({ autoAttach: view.autoAttach, groups: rest });
                },
              }, "删除组")),
            memberRows,
            el("div", null,
              el("button", {
                style: STYLES.button,
                disabled: !editable,
                onClick: function () { setGroup(gi, members.concat([""])); },
              }, "+ 添加路径")));
        });

        return el("div", { style: STYLES.root },
          el("div", { style: STYLES.muted },
            "跨机器路径别名：把从其他机器同步来的会话（其 cwd 在本机不存在）归组到同一项目的本地 workspace。" +
            "真实来源是 ~/.dsh/workspace-alias.json（跨机同步），此页的修改会写回该文件并同步到其他机器。"),
          el("label", { style: STYLES.label },
            el("input", {
              type: "checkbox",
              checked: view.autoAttach === true,
              disabled: !editable,
              onChange: function (event) {
                update({ autoAttach: event.target.checked, groups: view.groups });
              },
            }),
            el("span", null, "启动时自动附加经别名解析的跨机会话")),
          groupCards,
          el("div", null,
            el("button", {
              style: STYLES.primary,
              disabled: !editable,
              onClick: function () {
                update({ autoAttach: view.autoAttach, groups: cloneGroups(view.groups).concat([[""]]) });
              },
            }, "+ 添加别名组")),
          el("div", { style: STYLES.row },
            draft !== null
              ? el(react.Fragment, null,
                  el("button", { style: STYLES.primary, disabled: saving, onClick: save },
                    saving ? "保存中…" : "保存更改"),
                  el("button", { style: STYLES.button, disabled: saving, onClick: function () { setDraft(null); } }, "放弃更改"),
                  el("span", { style: STYLES.muted }, "修改尚未写入"))
              : el("span", { style: STYLES.muted }, "无未保存修改"),
            snap.writable === false
              ? el("span", { style: STYLES.muted }, "（当前连接为只读）") : null));
    }

    // ---- plugin body ---------------------------------------------------------

    function apply(ctx) {
      var scope = ctx.settingsScope.bind({ namespace: NAMESPACE });
      ctx.slots.inject("settings.section", function () {
        return ctx.slots.register({
          name: "settings.section",
          id: "workspace-alias",
          order: 60,
          label: "工作区别名",
        }, makeSectionComponent(scope));
      });
    }

    exports.apply = apply;
    exports.inject = ["slots", "settingsScope"];
    return module.exports;
  },
});
