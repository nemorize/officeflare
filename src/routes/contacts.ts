import { Hono } from "hono";
import type { AppEnv } from "../auth/types";
import { requireAccess } from "../auth/store";
import { requirePermission, requestPermissions } from "../authorization/access";
import { book } from "../contacts/store";
import folders from "../contacts/folders";
import fields from "../contacts/fields";
import entries from "../contacts/entries";
import search from "../contacts/search";
import { serviceSettings } from "../console/settings";

const contacts = new Hono<AppEnv>();
contacts.use("*", requireAccess, requirePermission("contacts.access"));
contacts.get("/capabilities", async (c) => {
  const config = (await serviceSettings(c.env, "contacts")).values;
  const blocked = !config.entries_enabled ? ["contacts.entries.create"] : [];
  return c.json({
    personal_books: true,
    shared_books: false,
    folder_membership: "single",
    nested_folders: true,
    custom_fields: true,
    creation: {
      contacts: !!config.entries_enabled,
      folders: !!config.folders_enabled,
      fields: !!config.fields_enabled,
    },
    trash: true,
    suggestions: true,
    max_page_size: 100,
    permissions: (await requestPermissions(c)).filter(
      (key) => key.startsWith("contacts.") && !blocked.includes(key),
    ),
  });
});
contacts.get("/books", async (c) => c.json({ books: [await book(c)] }));
contacts.route("/", folders);
contacts.route("/", fields);
contacts.route("/", search);
contacts.route("/", entries);
export default contacts;
