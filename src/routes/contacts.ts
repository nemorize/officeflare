import { Hono } from "hono";
import type { AppEnv } from "../auth/types";
import { requireAccess } from "../auth/store";
import { requirePermission, requestPermissions } from "../authorization/access";
import { book } from "../contacts/store";
import folders from "../contacts/folders";
import fields from "../contacts/fields";
import entries from "../contacts/entries";
import search from "../contacts/search";

const contacts = new Hono<AppEnv>();
contacts.use("*", requireAccess, requirePermission("contacts.access"));
contacts.get("/capabilities", async (c) =>
  c.json({
    personal_books: true,
    shared_books: false,
    folder_membership: "single",
    nested_folders: true,
    custom_fields: true,
    trash: true,
    suggestions: true,
    max_page_size: 100,
    permissions: (await requestPermissions(c)).filter((key) => key.startsWith("contacts.")),
  }),
);
contacts.get("/books", async (c) => c.json({ books: [await book(c)] }));
contacts.route("/", folders);
contacts.route("/", fields);
contacts.route("/", search);
contacts.route("/", entries);
export default contacts;
