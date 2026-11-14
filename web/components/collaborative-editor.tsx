import * as Y from "yjs";
import { useEffect, useRef, useState } from "react";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import { TableKit } from "@tiptap/extension-table";
import { t } from "../../shared/i18n/index.ts";
import { CollaborationClient, type CollaborationTransport } from "../lib/collaboration/client";
import { EditorBlockMenu } from "./editor-block-menu";
import { Button, Icon } from "./ui";
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
}: {
  client: CollaborationClient;
  onTitle?: (title: string) => void;
}) {
  const [, render] = useState(0),
    [title, setTitle] = useState(client.doc.getText("title").toString());
  const onTitleRef = useRef(onTitle);
  onTitleRef.current = onTitle;
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
  useEditorState({
    editor,
    selector: ({ editor: instance }) =>
      instance
        ? {
            selection: instance.state.selection.from,
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
  const editable =
    client.capabilities.write && !["reset", "error", "revoked"].includes(client.status);
  const setSharedTitle = (value: string) => {
    const branch = composition.current,
      target = branch?.doc ?? client.doc;
    const field = target.getText("title"),
      old = field.toString();
    let start = 0,
      end = 0;
    while (start < old.length && start < value.length && old[start] === value[start]) start++;
    while (
      end < old.length - start &&
      end < value.length - start &&
      old[old.length - 1 - end] === value[value.length - 1 - end]
    )
      end++;
    target.transact(() => {
      field.delete(start, old.length - start - end);
      field.insert(start, value.slice(start, value.length - end));
    });
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
  const statusLabel = client.status === "error" ? t("wiki.syncError") : t(`wiki.${client.status}`);
  return (
    <div className="collaborative-document">
      <div className="wiki-presence-row">
        <span role="status" className={`wiki-save-state state-${client.status}`}>
          {statusLabel}
        </span>
        <div className="wiki-participants" aria-label={t("wiki.participants")}>
          {client.participants.map((p) => (
            <span key={p.connection_id} title={p.name} style={{ background: p.color }}>
              {p.name.slice(0, 1)}
            </span>
          ))}
        </div>
        {(["error", "reset", "offline", "revoked"].includes(client.status) || client.unsaved) && (
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
      <input
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
      {editable && (
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
      )}
      <div
        className="wiki-editor-content"
        data-empty={editor?.isEmpty || undefined}
        data-placeholder={editable ? t("wiki.editorPlaceholder") : undefined}
      >
        <EditorContent editor={editor} />
      </div>
      <EditorBlockMenu editor={editor} editable={editable} />
      {editable && <p className="wiki-editor-help">{t("wiki.editorHint")}</p>}
    </div>
  );
}
export function CollaborativeEditor({
  resourceId,
  transport,
  onTitle,
  onClient,
}: {
  resourceId: string;
  transport: CollaborationTransport;
  onTitle?: (title: string) => void;
  onClient?: (client: CollaborationClient | null) => void;
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
  return <Editor key={resourceId} client={client} onTitle={onTitle} />;
}
