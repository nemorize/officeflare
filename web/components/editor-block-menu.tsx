import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { t } from "../../shared/i18n/index.ts";
import { Icon, type IconProps } from "./ui";

type BlockCommand = {
  id: string;
  label: string;
  hint: string;
  icon: IconProps["name"];
  words: string[];
  run: (editor: Editor, range: { from: number; to: number }) => void;
};
const commands = (): BlockCommand[] => [
  {
    id: "paragraph",
    label: t("wiki.paragraph"),
    hint: t("wiki.paragraphHint"),
    icon: "text",
    words: ["text", "paragraph"],
    run: (editor, range) => editor.chain().focus().deleteRange(range).setParagraph().run(),
  },
  ...([1, 2, 3] as const).map((level) => ({
    id: `h${level}`,
    label: t("wiki.headingLevel", { level }),
    hint: t("wiki.headingHint"),
    icon: "heading" as const,
    words: [`h${level}`, "heading"],
    run: (editor: Editor, range: { from: number; to: number }) =>
      editor.chain().focus().deleteRange(range).setHeading({ level }).run(),
  })),
  {
    id: "bullet",
    label: t("wiki.bulletList"),
    hint: t("wiki.listHint"),
    icon: "bulletList",
    words: ["bullet", "list"],
    run: (editor, range) => editor.chain().focus().deleteRange(range).toggleBulletList().run(),
  },
  {
    id: "number",
    label: t("wiki.orderedList"),
    hint: t("wiki.listHint"),
    icon: "numberedList",
    words: ["number", "ordered"],
    run: (editor, range) => editor.chain().focus().deleteRange(range).toggleOrderedList().run(),
  },
  {
    id: "quote",
    label: t("wiki.quote"),
    hint: t("wiki.quoteHint"),
    icon: "quote",
    words: ["quote"],
    run: (editor, range) => editor.chain().focus().deleteRange(range).toggleBlockquote().run(),
  },
  {
    id: "code",
    label: t("wiki.codeBlock"),
    hint: t("wiki.codeHint"),
    icon: "code",
    words: ["code"],
    run: (editor, range) => editor.chain().focus().deleteRange(range).toggleCodeBlock().run(),
  },
  {
    id: "table",
    label: t("wiki.table"),
    hint: t("wiki.tableHint"),
    icon: "table",
    words: ["table"],
    run: (editor, range) =>
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
        .run(),
  },
  {
    id: "divider",
    label: t("wiki.divider"),
    hint: t("wiki.dividerHint"),
    icon: "divider",
    words: ["divider", "line"],
    run: (editor, range) => editor.chain().focus().deleteRange(range).setHorizontalRule().run(),
  },
];
type MenuState = {
  from: number;
  to: number;
  query: string;
  left: number;
  top: number;
  above: boolean;
  items: BlockCommand[];
};
const key = new PluginKey("officeflare-block-menu");

/** Selection follows ProseMirror transactions, including concurrent remote edits. */
export function EditorBlockMenu({
  editor,
  editable,
}: {
  editor: Editor | null;
  editable: boolean;
}) {
  const [menu, setMenu] = useState<MenuState | null>(null),
    [selected, setSelected] = useState(0);
  const current = useRef(menu),
    index = useRef(selected),
    dismissed = useRef<string | null>(null),
    popup = useRef<HTMLDivElement | null>(null);
  current.current = menu;
  index.current = selected;
  const choose = (item: BlockCommand, state: MenuState) => {
    current.current = null;
    setMenu(null);
    dismissed.current = null;
    item.run(editor!, { from: state.from, to: state.to });
  };
  const chooseRef = useRef(choose);
  chooseRef.current = choose;
  useEffect(() => {
    if (!editor || !editable) {
      setMenu(null);
      return;
    }
    const update = () => {
      const { $from, empty } = editor.state.selection;
      const text = $from.parent.textBetween(0, $from.parentOffset, "", "\ufffc");
      if (
        !editor.isFocused ||
        !empty ||
        $from.parent.type.name !== "paragraph" ||
        !/^\/[^\s/]{0,24}$/.test(text)
      ) {
        current.current = null;
        setMenu(null);
        dismissed.current = null;
        return;
      }
      const from = $from.start(),
        to = $from.pos,
        query = text.slice(1).toLocaleLowerCase(),
        signature = `${from}:/${query}`;
      if (dismissed.current === signature) {
        setMenu(null);
        return;
      }
      const items = commands().filter(
        (command) =>
          command.label.toLocaleLowerCase().includes(query) ||
          command.words.some((word) => word.includes(query)),
      );
      const rect = editor.view.coordsAtPos(to),
        above = window.innerHeight - rect.bottom < 340;
      const next = {
        from,
        to,
        query,
        items,
        left: Math.max(12, Math.min(rect.left, window.innerWidth - 310)),
        top: above ? Math.max(12, rect.top - 8) : rect.bottom + 8,
        above,
      };
      if (current.current?.query !== query) {
        index.current = 0;
        setSelected(0);
      }
      current.current = next;
      setMenu(next);
    };
    const plugin = new Plugin({
      key,
      props: {
        handleKeyDown: (_view, event) => {
          const state = current.current;
          if (!state || event.isComposing) return false;
          if (event.key === "Escape") {
            dismissed.current = `${state.from}:/${state.query}`;
            current.current = null;
            setMenu(null);
            return true;
          }
          if (!state.items.length) return false;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            const next =
              (index.current + (event.key === "ArrowDown" ? 1 : -1) + state.items.length) %
              state.items.length;
            index.current = next;
            setSelected(next);
            return true;
          }
          if (event.key === "Enter" || event.key === "Tab") {
            chooseRef.current(state.items[index.current % state.items.length]!, state);
            return true;
          }
          return false;
        },
      },
    });
    editor.registerPlugin(plugin, (newPlugin, plugins) => [newPlugin, ...plugins]);
    editor.on("transaction", update);
    editor.on("selectionUpdate", update);
    editor.on("focus", update);
    editor.on("blur", update);
    const reposition = () => {
      if (current.current) update();
    };
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    update();
    return () => {
      editor.unregisterPlugin(key);
      editor.off("transaction", update);
      editor.off("selectionUpdate", update);
      editor.off("focus", update);
      editor.off("blur", update);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [editor, editable]);
  useEffect(() => {
    popup.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  if (!menu || !editable) return null;
  return createPortal(
    <div
      ref={popup}
      className={`wiki-block-menu ${menu.above ? "is-above" : ""}`}
      style={{ left: menu.left, top: menu.top }}
      onMouseDown={(event) => event.preventDefault()}
    >
      <div className="wiki-block-menu-heading">{t("wiki.insertBlock")}</div>
      <div role="listbox" aria-label={t("wiki.insertBlock")}>
        {menu.items.map((command, i) => (
          <button
            key={command.id}
            type="button"
            role="option"
            aria-selected={i === selected}
            onMouseEnter={() => setSelected(i)}
            onClick={() => choose(command, menu)}
          >
            <span className="wiki-block-command-icon">
              <Icon name={command.icon} />
            </span>
            <span>
              <strong>{command.label}</strong>
              <small>{command.hint}</small>
            </span>
          </button>
        ))}
      </div>
      {!menu.items.length && <p>{t("wiki.noBlocks")}</p>}
      <footer>{t("wiki.blockMenuHint")}</footer>
    </div>,
    document.body,
  );
}
