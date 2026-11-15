import { useRef, useState } from "react";
import type { Editor } from "@tiptap/core";
import { Selection } from "@tiptap/pm/state";
import DragHandle from "@tiptap/extension-drag-handle-react";
import { t } from "../../shared/i18n/index.ts";
import { Button, Icon, Menu, MenuPopup } from "./ui";

const positionConfig = { placement: "left-start" as const, strategy: "absolute" as const };
export function EditorBlockActions({ editor }: { editor: Editor }) {
  const position = useRef(0),
    [open, setOpen] = useState(false);
  const node = () => editor.state.doc.nodeAt(position.current);
  const insert = () => {
    const value = node();
    if (!value) return;
    const at =
      value.type.name === "paragraph" && !value.content.size
        ? position.current
        : position.current + value.nodeSize;
    if (at === position.current)
      editor
        .chain()
        .focus()
        .insertContentAt(at + 1, "/")
        .setTextSelection(at + 2)
        .run();
    else
      editor
        .chain()
        .focus()
        .insertContentAt(at, { type: "paragraph", content: [{ type: "text", text: "/" }] })
        .setTextSelection(at + 2)
        .run();
  };
  const select = () => {
    const selection = Selection.near(
      editor.state.doc.resolve(Math.min(position.current + 1, editor.state.doc.content.size)),
    );
    return editor.chain().focus().setTextSelection({ from: selection.from, to: selection.to });
  };
  const move = (direction: number) => {
    const blocks: { pos: number; size: number }[] = [];
    editor.state.doc.forEach((n, pos) => blocks.push({ pos, size: n.nodeSize }));
    const index = blocks.findIndex((block) => block.pos === position.current),
      target = blocks[index + direction],
      source = blocks[index];
    if (!source || !target) return;
    const value = node();
    if (!value) return;
    const destination = direction < 0 ? target.pos : target.pos + target.size;
    const transaction = editor.state.tr.delete(source.pos, source.pos + source.size);
    transaction.insert(transaction.mapping.map(destination), value);
    editor.view.dispatch(transaction.scrollIntoView());
    editor.commands.focus();
  };
  return (
    <DragHandle
      editor={editor}
      className="wiki-block-handles"
      computePositionConfig={positionConfig}
      getReferencedVirtualElement={() => {
        const element = editor.view.nodeDOM(position.current);
        return element instanceof HTMLElement
          ? {
              getBoundingClientRect: () => element.getBoundingClientRect(),
              contextElement: element,
            }
          : null;
      }}
      onNodeChange={({ pos }) => {
        if (pos >= 0) position.current = pos;
      }}
    >
      <Button
        variant="ghost"
        size="icon"
        aria-label={t("wiki.insertBlock")}
        onMouseDown={(event) => event.preventDefault()}
        onClick={insert}
      >
        <Icon name="plus" />
      </Button>
      <Menu.Root
        open={open}
        onOpenChange={(value) => {
          setOpen(value);
          editor.commands.setMeta("lockDragHandle", value);
        }}
      >
        <Menu.Trigger
          render={<Button variant="ghost" size="icon" aria-label={t("wiki.blockActions")} />}
          // Open on release so pressing the grip can begin a native block drag.
          onPointerDown={(event) => event.preventBaseUIHandler()}
          onMouseDown={(event) => event.preventBaseUIHandler()}
        >
          <Icon name="grip" />
        </Menu.Trigger>
        <MenuPopup className="wiki-block-actions">
          {!["table", "fileAttachment"].includes(node()?.type.name ?? "") && (
            <Menu.Group>
              <Menu.GroupLabel>{t("wiki.turnInto")}</Menu.GroupLabel>
              <Menu.Item onClick={() => select().setParagraph().run()}>
                <Icon name="text" />
                {t("wiki.paragraph")}
              </Menu.Item>
              {([1, 2, 3] as const).map((level) => (
                <Menu.Item key={level} onClick={() => select().setHeading({ level }).run()}>
                  <Icon name="heading" />
                  {t("wiki.headingLevel", { level })}
                </Menu.Item>
              ))}
              <Menu.Item onClick={() => select().toggleBulletList().run()}>
                <Icon name="bulletList" />
                {t("wiki.bulletList")}
              </Menu.Item>
              <Menu.Item onClick={() => select().toggleBlockquote().run()}>
                <Icon name="quote" />
                {t("wiki.quote")}
              </Menu.Item>
            </Menu.Group>
          )}
          <Menu.Separator />
          <Menu.Item
            onClick={() => {
              const value = node();
              if (value)
                editor
                  .chain()
                  .focus()
                  .insertContentAt(position.current + value.nodeSize, value.toJSON())
                  .run();
            }}
          >
            <Icon name="copy" />
            {t("wiki.duplicateBlock")}
          </Menu.Item>
          <Menu.Item onClick={() => move(-1)}>
            <Icon name="sort" />
            {t("wiki.moveBlockUp")}
          </Menu.Item>
          <Menu.Item onClick={() => move(1)}>
            <Icon name="sort" />
            {t("wiki.moveBlockDown")}
          </Menu.Item>
          <Menu.Separator />
          <Menu.Item
            data-variant="danger"
            onClick={() => {
              const value = node();
              if (value)
                editor
                  .chain()
                  .focus()
                  .deleteRange({ from: position.current, to: position.current + value.nodeSize })
                  .run();
            }}
          >
            <Icon name="trash" />
            {t("wiki.deleteBlock")}
          </Menu.Item>
        </MenuPopup>
      </Menu.Root>
    </DragHandle>
  );
}
