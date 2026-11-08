# 模型测速（local-model-speedtest）

点一下就给某个模型测一次真实速度：**首字延迟 + 生成速度 t/s**。按渠道分组，组名可一键测全部。

## 两个入口

**手机（dsh-go）**
「全部功能」或对话详情页「插件」页签里的 **模型测速** 面板。
- 按 provider 分组：`▸ 渠道名  16 个模型 · 已测 3  ⚡ 测全部`
- 点组名 → 后台一次测完该组全部模型（并发 3），结果实时刷新，有「停止测速」
- 点单个模型行 → 只测它自己
- 输入框上方状态条显示最近一次结果，点一下打开面板

**桌面版 / 网页版**
输入框上方模型选择器里，每个模型名旁边多一个 **⚡**；菜单/选项行里还有 **测本组** 按钮。
- 点 ⚡ → 真实测一次，名字后显示 `1.43s · 66.5 t/s`
- 点「测本组」→ 一次测完同渠道全部模型（并发 2）
- 结果缓存，刷新后还在

## 怎么测的

- 发一句固定短句，`maxTokens=160`，要求模型原样复述
- 首字延迟 = 第一个 token 到达时间 − 请求发出时间
- t/s = 输出 token 数 ÷（最后一个 token 时间 − 第一个 token 时间）
- 输出 token 数优先用渠道返回的 usage.outputTokens，没有就用收到的增量条数

## 接口（桌面端浏览器半身用的）

- `GET  /plugins/local-model-speedtest/catalog` → `{groups:[{provider,name,models:[...]}], models:[...]}`
- `POST /plugins/local-model-speedtest/bench` → `{provider, model}`，返回 `{ok, firstMs, tps, tokens, totalMs}`

## 装 / 卸

装在 web profile：`dsh plugin --profile web add /root/.dsh/dsh-go/plugins/local-model-speedtest`

卸载：
1. `dsh plugin --profile web remove local-model-speedtest`
2. 删掉这个目录

## 注意

- 测一次会消耗对应渠道一次额度（约 160 tokens）；配额耗尽的渠道直接显示失败原因。
- 分组测速是后台任务，不受单次 60 秒限制；点「停止测速」保留已完成结果。
- 结果缓存在插件目录的 `.cache.json`（手机）和浏览器 localStorage（网页）。
