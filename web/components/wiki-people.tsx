import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { PersonAvatar, PersonPhotosProvider, type Person } from "./person-avatar";
const People = createContext<Person[]>([]);
export function WikiPeople({ pageId, children }: { pageId: string; children: ReactNode }) {
  const [people, setPeople] = useState<Person[]>([]);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const load = () =>
      void api<{ members: (Person & { user_id: string })[] }>(`/api/wiki/pages/${pageId}/people`, {
        signal: controller.signal,
      })
        .then((data) => {
          if (active) setPeople(data.members.map((p) => ({ ...p, id: p.user_id })));
        })
        .catch(() => {
          if (active) setPeople([]);
        });
    load();
    const timer = setInterval(load, 10000);
    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [pageId]);
  return (
    <People value={people}>
      <PersonPhotosProvider basePath={`/api/wiki/pages/${pageId}/people`}>
        {children}
      </PersonPhotosProvider>
    </People>
  );
}
export function WikiAvatar({
  id,
  name,
  person,
}: {
  id: string;
  name: string;
  person?: Partial<Person>;
}) {
  const people = useContext(People);
  return (
    <PersonAvatar
      className="wiki-person-avatar"
      person={{ ...people.find((p) => p.id === id), ...person, id, display_name: name }}
    />
  );
}
