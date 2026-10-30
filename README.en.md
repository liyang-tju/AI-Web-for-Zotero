# AI Web for Zotero

[简体中文](README.md) | **English**

<img src="addon/icons/logo.svg" width="96" height="96" alt="AI Web for Zotero" />

Open AI websites inside Zotero and discuss papers as you read, without setting up AI APIs or agents.
Upload multiple PDFs, bookmark conversations, and export chat history.

[Download](https://github.com/liyang-tju/AI-Web-for-Zotero/releases/latest) · [Report an issue](https://github.com/liyang-tju/AI-Web-for-Zotero/issues)

**Supports Zotero 10.** No API key is required. Sign in with your account on the website to get started.

## Features

- **Independent web panel**: Place it on the right or at the bottom of the reader, and drag to resize.
- **PDF uploads**: Upload the PDF you are reading, or right-click selected library items to upload their attachments. Multiple PDFs can be selected.
- **Conversation bookmarks**: Save multiple conversation links for your papers and return to previous discussions.
- **Conversation export**: Choose the exchanges you want to save as a Zotero note, HTML file, or Markdown file under the current library item.
- **Chinese and English interface**: Follows Zotero's language by default, with a manual language switch.

## Installation

1. Download the `.xpi` file from [Releases](https://github.com/liyang-tju/AI-Web-for-Zotero/releases/latest), not a Source code archive.
2. In Zotero, open **Tools → Plugins**.
3. Click the gear icon in the upper right, choose **Install Plugin From File**, and select the downloaded `.xpi`.

You can install over an earlier version to upgrade while keeping your bookmarks and settings.

## Usage

Click the website button at the top right of Zotero, or open **Tools → AI Web for Zotero**.

| Action | How |
| --- | --- |
| Open an AI website | Select **Show / hide webpage** and sign in on your first visit |
| Switch websites | Choose a website from **Switch website** |
| Upload the current paper | Open its PDF and select **Upload current PDF** |
| Upload multiple papers | Select items or attachments in the library, right-click, and choose **Upload PDF** |
| Bookmark a conversation | Open a conversation, select **Save bookmark**, and return to it through **Conversation bookmarks** |
| Save chat content | Select **Export conversation**, then choose the exchanges and output format |
| Move the panel to the bottom | Enable **Show at bottom** |

## Supported websites

ChatGPT, Gemini, Google AI Studio, DeepSeek, Kimi, and GLM / ChatGLM (智谱清言).

You can also enter a custom URL. Custom websites support browsing, but PDF uploads and conversation export are not guaranteed. Website changes may affect compatibility. If you run into a problem, include the website name, Zotero version, and error message in an [issue](https://github.com/liyang-tju/AI-Web-for-Zotero/issues).

## License

Released under the [MIT License](LICENSE).
