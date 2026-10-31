# AI Web for Zotero

**简体中文** | [English](README.en.md)

<img src="addon/icons/logo.svg" width="96" height="96" alt="AI Web for Zotero" />

在 Zotero 中打开 AI 网页，一边阅读文献，一边与AI讨论，无需配置繁杂的 AI API 或 Agent。
支持一键上传多个 PDF ，保存对话链接书签以及导出对话聊天记录。

[下载插件](https://github.com/liyang-tju/AI-Web-for-Zotero/releases/latest) · [反馈问题](https://github.com/liyang-tju/AI-Web-for-Zotero/issues)

支持**Zotero 7-10**。无需 API Key，直接登录网站账号即可使用。

## 主要功能

- **独立网页面板**：显示在阅读器右侧或底部，可拖动调整尺寸。
- **上传文献**：上传当前 PDF，或在文献库选中条目后右键上传；支持选择多个 PDF 附件。
- **对话书签**：为文献保存多个对话链接，随时返回之前的讨论。
- **导出对话**：选择需要的问答，保存为当前文献条目下的 Zotero 笔记、HTML 或 Markdown 文件。
- **中英文界面**：默认跟随 Zotero，也可手动切换中英文。

## 安装

1. 从 [Releases](https://github.com/liyang-tju/AI-Web-for-Zotero/releases/latest) 下载 `.xpi` 文件，请勿下载 Source code 压缩包。
2. 在 Zotero 打开 **工具 → 插件**。
3. 点击右上角齿轮，选择 **从文件安装插件**，打开下载的 `.xpi`。

已安装旧版的用户可以直接覆盖升级，保留原有书签和设置。

## 使用

点击 Zotero 顶部右侧的网站按钮，或打开 **工具 → AI Web for Zotero**。

| 操作 | 方法 |
| --- | --- |
| 打开 AI 网页 | 选择“打开 / 收起网页”，首次使用时登录网站账号 |
| 切换网站 | 在“切换网页”中选择不同的网页 |
| 上传当前文献 | 打开 PDF 后选择“上传当前 PDF” |
| 上传多篇文献 | 在文献库选中条目或附件，右键选择“上传 PDF” |
| 保存对话书签 | 进入正式对话后选择“保存书签”，之后从“对话书签”打开 |
| 保存聊天内容 | 选择“导出对话”，勾选问答轮次和保存格式 |
| 改为底部显示 | 勾选“在底部显示” |

## 支持的网站

ChatGPT、Gemini、Google AI Studio、DeepSeek、Kimi、智谱清言。

也可以输入自定义网址，遇到问题可在 [Issues](https://github.com/liyang-tju/AI-Web-for-Zotero/issues) 中附上网站名称、Zotero 版本和错误提示。

## 许可证

采用 [MIT 许可证](LICENSE)。
