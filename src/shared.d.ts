// API exposed by the preload script as window.mdview.

export interface DocInfo {
  path: string | null; // null = untitled
  content: string;
  baseUrl: string | null; // file:// URL of the document's folder, for relative images
}

export type MenuCommand = 'save' | 'save-as' | 'toggle-edit' | 'rich' | 'plain' | 'save-and-close';

export interface MdviewApi {
  init(): Promise<DocInfo>;
  save(content: string): Promise<DocInfo | null>; // null = cancelled or failed
  saveAs(content: string): Promise<DocInfo | null>;
  setDirty(dirty: boolean): void;
  setEditing(editing: boolean): void;
  openLink(href: string): void;
  closeAfterSave(): void;
  confirmReload(): Promise<boolean>;
  onMenu(fn: (cmd: MenuCommand) => void): void;
  onExternalChange(fn: (content: string) => void): void;
}

declare global {
  interface Window {
    mdview: MdviewApi;
  }
}
