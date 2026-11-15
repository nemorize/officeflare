import { replaceSharedText } from "../lib/collaboration/text";
import type { ReactNode } from "react";
import type { CollaborationParticipant } from "../../shared/collaboration";
import * as Y from "yjs";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BubbleMenu } from "@tiptap/react/menus";
import { useWorkspaceMobile } from "../lib/workspace-responsive";
import { EditorBlockActions } from "./editor-block-actions";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import { TableKit } from "@tiptap/extension-table";
import { t } from "../../shared/i18n/index.ts";
import { CollaborationClient, type CollaborationTransport } from "../lib/collaboration/client";
import { EditorBlockMenu } from "./editor-block-menu";
import { Button, Icon, Popover, PopoverPopup } from "./ui";
export function downloadText(filename: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function Editor({
  client,
  onTitle,
  statusContainer,
  renderParticipant,
}: {
  client: CollaborationClient;
  onTitle?: (title: string) => void;
  renderParticipant?: (person: CollaborationParticipant) => ReactNode;
  statusContainer?: HTMLElement | null;
}) {
  const mobile = useWorkspaceMobile();
  const [focused, setFocused] = useState(false);
  const [, render] = useState(0),
    [title, setTitle] = useState(client.doc.getText("title").toString());
  const onTitleRef = useRef(onTitle);
  onTitleRef.current = onTitle;
  const titleInput = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const field = titleInput.current;
    if (field) {
      field.style.height = "auto";
      field.style.height = `${field.scrollHeight}px`;
    }
  }, [title]);
  const composing = useRef(false);
  const composition = useRef<{ doc: Y.Doc; vector: Uint8Array } | null>(null);
  useEffect(() => () => composition.current?.doc.destroy(), []);
  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({ undoRedo: false, link: { openOnClick: false } }),
        TableKit.configure({ table: { resizable: true } }),
        Collaboration.configure({ document: client.doc, field: "content" }),
        CollaborationCaret.configure({
          provider: client,
          user: { name: client.user?.name, color: client.user?.color },
        }),
      ],
      editable: client.capabilities.write,
      editorProps: {
        attributes: { class: "collaborative-prose", "aria-label": t("wiki.editorLabel") },
      },
      immediatelyRender: false,
    },
    [client],
  );
  useEffect(() => {
    if (!editor) return;
    const focus = () => setFocused(true),
      blur = () => setFocused(false);
    editor.on("focus", focus);
    editor.on("blur", blur);
    return () => {
      editor.off("focus", focus);
      editor.off("blur", blur);
    };
  }, [editor]);
  useEditorState({
    editor,
    selector: ({ editor: instance }) =>
      instance
        ? {
            selection: instance.state.selection.from,
            selectionEnd: instance.state.selection.to,
            doc: instance.state.doc,
            marks: instance.state.storedMarks,
          }
        : null,
  });
  useEffect(
    () =>
      client.subscribe(() => {
        render((v) => v + 1);
        editor?.setEditable(
          client.capabilities.write && !["reset", "error", "revoked"].includes(client.status),
        );
      }),
    [client, editor],
  );
  useEffect(() => {
    const field = client.doc.getText("title"),
      changed = () => {
        const value = field.toString();
        if (!composing.current) setTitle(value);
        onTitleRef.current?.(value);
      };
    changed();
    field.observe(changed);
    return () => field.unobserve(changed);
  }, [client]);
  useEffect(() => {
    if (client.capabilities.write && !client.doc.getText("title").length)
      titleInput.current?.focus();
  }, [client]);
  const editable =
    client.capabilities.write && !["reset", "error", "revoked"].includes(client.status);
  const setSharedTitle = (value: string) => {
    const branch = composition.current,
      target = branch?.doc ?? client.doc;
    replaceSharedText(target.getText("title"), value);
    if (branch) {
      Y.applyUpdate(client.doc, Y.encodeStateAsUpdate(branch.doc, branch.vector));
      branch.doc.destroy();
      composition.current = null;
    }
    setTitle(client.doc.getText("title").toString());
  };
  const actions = [
    {
      label: t("wiki.bold"),
      icon: "bold" as const,
      run: () => editor?.chain().focus().toggleBold().run(),
      active: editor?.isActive("bold"),
    },
    {
      label: t("wiki.italic"),
      icon: "italic" as const,
      run: () => editor?.chain().focus().toggleItalic().run(),
      active: editor?.isActive("italic"),
    },
    {
      label: t("wiki.heading"),
      icon: "heading" as const,
      run: () => editor?.chain().focus().toggleHeading({ level: 2 }).run(),
      active: editor?.isActive("heading"),
    },
    {
      label: t("wiki.bulletList"),
      icon: "bulletList" as const,
      run: () => editor?.chain().focus().toggleBulletList().run(),
    },
    {
      label: t("wiki.orderedList"),
      icon: "numberedList" as const,
      run: () => editor?.chain().focus().toggleOrderedList().run(),
    },
    {
      label: t("wiki.quote"),
      icon: "quote" as const,
      run: () => editor?.chain().focus().toggleBlockquote().run(),
    },
    {
      label: t("wiki.codeBlock"),
      icon: "code" as const,
      run: () => editor?.chain().focus().toggleCodeBlock().run(),
    },
    {
      label: t("wiki.table"),
      icon: "table" as const,
      run: () =>
        editor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
    },
    {
      label: t("wiki.undo"),
      icon: "undo" as const,
      run: () => editor?.chain().focus().undo().run(),
    },
    {
      label: t("wiki.redo"),
      icon: "redo" as const,
      run: () => editor?.chain().focus().redo().run(),
    },
  ];
  const toolbar = (
    <div className="wiki-editor-toolbar" role="toolbar" aria-label={t("wiki.editorLabel")}>
      {actions.map((action) => (
        <Button
          key={action.label}
          variant="ghost"
          size="icon"
          title={action.label}
          aria-label={action.label}
          aria-pressed={action.active}
          onMouseDown={(event) => event.preventDefault()}
          onClick={action.run}
        >
          <Icon name={action.icon} />
        </Button>
      ))}
    </div>
  );
  const statusLabel = client.status === "error" ? t("wiki.syncError") : t(`wiki.${client.status}`);
  const participants = [...new Map(client.participants.map((p) => [p.user_id, p])).values()];
  const presence = (
    <div className="wiki-presence-row">
      <span role="status" className={`wiki-save-state state-${client.status}`}>
        {statusLabel}
      </span>
      <div className="wiki-participants" aria-label={t("wiki.participants")}>
        {participants.slice(0, 4).map((p) => (
          <span
            key={p.user_id}
            title={p.name}
            role="img"
            aria-label={p.name}
            style={{ background: p.color }}
          >
            {renderParticipant?.(p) ?? p.name.slice(0, 1)}
          </span>
        ))}
        {participants.length > 4 && (
          <Popover.Root>
            <Popover.Trigger
              render={<Button variant="ghost" size="sm" aria-label={t("wiki.participants")} />}
            >
              +{participants.length - 4}
            </Popover.Trigger>
            <PopoverPopup>
              <Popover.Title>{t("wiki.participants")}</Popover.Title>
              <ul className="wiki-participant-list">
                {participants.map((p) => (
                  <li key={p.user_id}>
                    {renderParticipant?.(p)}
                    <span>{p.name}</span>
                  </li>
                ))}
              </ul>
            </PopoverPopup>
          </Popover.Root>
        )}
      </div>
      {["error", "reset", "offline", "revoked"].includes(client.status) && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            downloadText(
              `${title || t("wiki.untitled")}.txt`,
              `${title}\n\n${editor?.getText() ?? ""}`,
            )
          }
        >
          {t("wiki.copyLocal")}
        </Button>
      )}
    </div>
  );
  return (
    <div className="collaborative-document">
      {statusContainer && !mobile ? createPortal(presence, statusContainer) : presence}
      <textarea
        ref={titleInput}
        rows={1}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            editor?.commands.focus("start");
          }
        }}
        className="wiki-title"
        aria-label={t("wiki.pageTitle")}
        placeholder={t("wiki.untitled")}
        maxLength={500}
        value={title}
        readOnly={!editable}
        onCompositionStart={() => {
          composing.current = true;
          composition.current?.doc.destroy();
          const doc = new Y.Doc();
          Y.applyUpdate(doc, Y.encodeStateAsUpdate(client.doc));
          composition.current = { doc, vector: Y.encodeStateVector(doc) };
        }}
        onCompositionEnd={(event) => {
          composing.current = false;
          setSharedTitle(event.currentTarget.value);
        }}
        onChange={(event) => {
          if (composing.current) setTitle(event.target.value);
          else setSharedTitle(event.target.value);
        }}
      />
      {editable && editor && (
        <>
          {!mobile && (
            <BubbleMenu editor={editor} options={{ placement: "top", offset: 8 }} updateDelay={0}>
              {toolbar}
            </BubbleMenu>
          )}
          <EditorBlockActions editor={editor} />
        </>
      )}
      <div className="wiki-editor-content">
        <EditorContent editor={editor} />
      </div>
      {editable && focused && <div className="wiki-mobile-formatting">{toolbar}</div>}
      <EditorBlockMenu editor={editor} editable={editable} />
    </div>
  );
}
export function CollaborativeEditor({
  resourceId,
  transport,
  onTitle,
  onClient,
  statusContainer,
  renderParticipant,
}: {
  resourceId: string;
  transport: CollaborationTransport;
  onTitle?: (title: string) => void;
  onClient?: (client: CollaborationClient | null) => void;
  renderParticipant?: (person: CollaborationParticipant) => ReactNode;
  statusContainer?: HTMLElement | null;
}) {
  const [generation, setGeneration] = useState(0);
  const [client, setClient] = useState<CollaborationClient | null>(null),
    [, render] = useState(0);
  const callback = useRef(onClient);
  callback.current = onClient;
  useEffect(() => {
    const instance = new CollaborationClient(resourceId, transport);
    setClient(instance);
    callback.current?.(instance);
    let reopening = false;
    const unsubscribe = instance.subscribe(() => {
      render((v) => v + 1);
      if (instance.status === "reset" && !instance.unsaved && !reopening) {
        reopening = true;
        setGeneration((v) => v + 1);
      }
    });
    void instance.connect();
    const unload = (event: BeforeUnloadEvent) => {
      if (instance.unsaved) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", unload);
    return () => {
      unsubscribe();
      instance.destroy();
      callback.current?.(null);
      window.removeEventListener("beforeunload", unload);
    };
  }, [resourceId, transport, generation]);
  if (!client?.synced)
    return (
      <p role="status">
        {client?.status === "revoked"
          ? t("wiki.revoked")
          : client?.status === "error"
            ? t("wiki.syncError")
            : t("wiki.connecting")}
      </p>
    );
  return (
    <Editor
      key={resourceId}
      client={client}
      onTitle={onTitle}
      statusContainer={statusContainer}
      renderParticipant={renderParticipant}
    />
  );
}
