const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const defaultId = 'default';
const defaultProfile = { id: defaultId, name: 'Основной' };
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function localProfiles(directory) {
  const file = path.join(directory, 'profiles.json');
  let data = {};
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')) ?? {}; }
  catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  const entries = new Map([[defaultId, defaultProfile]]);
  for (const profile of Array.isArray(data.profiles) ? data.profiles.slice(0, 50) : []) {
    if (typeof profile?.id !== 'string' || (profile.id !== defaultId && !uuid.test(profile.id))) continue;
    if (typeof profile.name !== 'string' || !profile.name.trim()) continue;
    entries.set(profile.id, { id: profile.id, name: profile.name.trim().slice(0, 48) });
  }
  let selected = entries.has(data.selected) ? data.selected : defaultId;

  function write(next, id) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(temporary, JSON.stringify({ profiles: [...next.values()], selected: id }), { flag: 'wx' });
      fs.renameSync(temporary, file);
      selected = id;
    } finally { fs.rmSync(temporary, { force: true }); }
  }

  function nameFor(value, id) {
    const name = typeof value === 'string' ? value.trim().slice(0, 48) : '';
    if (!name) throw new Error('Введи имя профиля.');
    if ([...entries.values()].some((item) => item.id !== id && item.name.toLowerCase() === name.toLowerCase())) {
      throw new Error('Профиль с таким именем уже есть.');
    }
    return name;
  }

  return {
    get selected() { return selected; },
    list: () => [...entries.values()],
    get(id) { return entries.get(id); },
    directory(id) {
      if (!entries.has(id)) throw new Error('Профиль недоступен.');
      return id === defaultId ? directory : path.join(directory, 'Profiles', id);
    },
    select(id) {
      if (!entries.has(id)) throw new Error('Профиль недоступен.');
      if (id !== selected) write(entries, id);
    },
    create(value) {
      if (entries.size >= 50) throw new Error('Достигнут предел в 50 профилей.');
      const id = randomUUID();
      const profile = { id, name: nameFor(value, id) };
      write(new Map(entries).set(id, profile), selected);
      entries.set(id, profile);
      return profile;
    },
    rename(id, value) {
      if (!entries.has(id)) throw new Error('Профиль недоступен.');
      const profile = { id, name: nameFor(value, id) };
      write(new Map(entries).set(id, profile), selected);
      entries.set(id, profile);
    },
  };
}

module.exports = { localProfiles, defaultId };
