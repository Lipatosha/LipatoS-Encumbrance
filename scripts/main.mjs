const ID = "lipatos-encumbrance";
const TITLES = ["", "Нагрузка", "Сильная нагрузка", "Перегрузка"];
const DETAILS = [
  "",
  "Скорость перемещения уменьшается на 10 футов.",
  "Скорость перемещения уменьшается на 20 футов. Помеха на броски атаки, проверки характеристик и спасброски с использованием Силы, Ловкости или Телосложения.",
  "Скорость перемещения становится 0 футов. Помеха на броски атаки, проверки характеристик и спасброски с использованием Силы, Ловкости или Телосложения."
];
const EFFECT_ICON = "icons/svg/weight.svg";
const queues = new Map();

function num(value, fallback = NaN) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// Read prepared encumbrance data from dnd5e, never count inventory a second time.
function encumbrance(actor) {
  return actor?.system?.attributes?.encumbrance ?? {};
}

function getTier(actor) {
  if (!actor || actor.type !== "character") return 0;
  const e = encumbrance(actor);
  const value = num(e.value);
  const max = num(e.max);
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0;
  // D&D5e 6.x encumbrance meter expresses its breakpoints as percentages.
  // Prefer the system's own breakpoints if they are exposed on the model.
  const stops = e.stops ?? e.breakpoints ?? {};
  const lowPercent = num(stops.encumbered, 100 / 3);
  const highPercent = num(stops.heavilyEncumbered, 200 / 3);
  const lower = max * lowPercent / 100;
  const higher = max * highPercent / 100;
  if (value > max) return 3;
  if (value > higher) return 2;
  if (value > lower) return 1;
  return 0;
}

function metric(actor) {
  return ["m", "meter", "meters"].includes(String(actor?.system?.attributes?.movement?.units ?? "").toLowerCase());
}

function speedPenalty(actor, amountFeet) {
  return String(-(metric(actor) ? amountFeet * 0.3 : amountFeet));
}

function effectChanges(tier, actor) {
  const M = CONST.ACTIVE_EFFECT_MODES;
  const changes = [];
  if (tier === 1 || tier === 2) {
    changes.push({key: "system.attributes.movement.bonus", mode: M.ADD, value: speedPenalty(actor, tier === 1 ? 10 : 20), priority: 20});
  } else if (tier === 3) {
    changes.push({key: "system.attributes.movement.multiplier", mode: M.OVERRIDE, value: "0", priority: 90});
  }
  if (tier >= 2) {
    for (const ability of ["str", "dex", "con"]) {
      for (const kind of ["attack", "check", "save"]) {
        changes.push({key: "system.abilities." + ability + "." + kind + ".roll.mode", mode: M.ADD, value: "-1", priority: 20});
      }
    }
  }
  return changes;
}

function ourEffect(actor) {
  return [...(actor?.effects ?? [])].find(e => e.getFlag(ID, "automated") === true);
}

async function synchronize(actor) {
  if (!game.user?.isGM || !actor || actor.type !== "character" || !actor.id) return;
  const tier = getTier(actor);
  const effect = ourEffect(actor);
  if (tier === 0) {
    if (effect) await effect.delete();
    return;
  }
  const payload = {
    name: TITLES[tier],
    img: EFFECT_ICON,
    description: DETAILS[tier],
    disabled: false,
    transfer: false,
    changes: effectChanges(tier, actor),
    flags: {[ID]: {automated: true, tier}}
  };
  if (effect) {
    if (effect.getFlag(ID, "tier") !== tier || effect.disabled) await effect.update(payload);
  } else {
    await actor.createEmbeddedDocuments("ActiveEffect", [payload]);
  }
}

function enqueue(actor) {
  if (!actor || !game.user?.isGM || !actor.id || actor.type !== "character") return;
  if (queues.has(actor.uuid)) clearTimeout(queues.get(actor.uuid));
  queues.set(actor.uuid, setTimeout(async () => {
    queues.delete(actor.uuid);
    try { await synchronize(actor); }
    catch (err) { console.error("LipatoS Encumbrance: effect synchronization failed", err); }
  }, 100));
}

// Movement speed from prepared dnd5e movement data (after Active Effects).
function getSpeed(actor) {
  const movement = actor?.system?.attributes?.movement ?? {};
  const speed = movement.walk ?? movement.speeds?.walk ?? movement.speed;
  const value = typeof speed === "object" ? (speed.value ?? speed.total ?? speed.number) : speed;
  return Math.max(0, num(value, 0));
}

function currentTurn(document) {
  const combat = game.combat;
  const own = document.combatant;
  if (!combat?.started || !own || own.id !== combat.combatant?.id) return null;
  return {combat, own};
}

function dashFlag(document) {
  return document.getFlag(ID, "dash") ?? {};
}

function dashUsed(document) {
  const turn = currentTurn(document);
  if (!turn) return false;
  const d = dashFlag(document);
  return d.combat === turn.combat.id && d.round === turn.combat.round && d.turn === turn.combat.turn;
}

function canDash(document) {
  return Boolean(!game.user?.isGM && document?.actor?.type === "character" && document.isOwner && currentTurn(document) && !dashUsed(document) && getSpeed(document.actor) > 0);
}

async function useDash(document) {
  if (!canDash(document)) return false;
  const {combat} = currentTurn(document);
  await document.setFlag(ID, "dash", {combat: combat.id, round: combat.round, turn: combat.turn});
  ui.notifications.info("Рывок: к доступному перемещению добавлена ещё одна скорость. Действие потрачено.");
  return true;
}

function rejectMove(message) {
  ui.notifications.warn(message);
  return false;
}

function validateMovement(document, movement) {
  if (game.user?.isGM) return;
  if (!document?.actor || document.actor.type !== "character" || !document.isOwner) return;
  const speed = getSpeed(document.actor);
  // When speed is 0 a player cannot move the token, whether or not combat is active.
  if (speed <= 0) return rejectMove("Перемещение невозможно: скорость персонажа равна 0.");
  const combat = game.combat;
  if (!combat?.started || !document.combatant || document.combatant.parent?.id !== combat.id) return;
  if (combat.combatant?.id !== document.combatant.id) return rejectMove("Сейчас не ваш ход.");
  const additional = dashUsed(document) ? speed : 0;
  const budget = speed + additional;
  // Core v14 preMoveToken supplies measured costs, including terrain and history.
  const prior = num(movement.history?.cost, 0);
  const passed = num(movement.passed?.cost, 0);
  const pending = num(movement.pending?.cost, 0);
  const spent = prior + passed + pending;
  if (spent > budget + 0.01) return rejectMove("Недостаточно перемещения: доступно " + budget + ", затраты " + Math.round(spent * 10) / 10 + ". Используйте «Рывок», если действие доступно.");
}

Hooks.once("init", () => {
  game.settings.register(ID, "enabled", {
    name: "Автоматизировать нагрузку",
    hint: "Синхронизировать три уровня нагрузки с Active Effects D&D5e.",
    scope: "world", config: true, type: Boolean, default: true
  });
  game.modules.get(ID).api = {getTier, getSpeed, dashUsed, canDash, useDash};
});

Hooks.once("ready", () => {
  if (game.system.id !== "dnd5e") return;
  if (game.user.isGM && game.settings.get(ID, "enabled")) {
    for (const actor of game.actors) enqueue(actor);
  }
});
for (const hook of ["createItem", "updateItem", "deleteItem"]) {
  Hooks.on(hook, item => {
    if (game.settings.get(ID, "enabled")) enqueue(item.parent);
  });
}
Hooks.on("updateActor", actor => {
  if (game.settings.get(ID, "enabled")) enqueue(actor);
});
Hooks.on("createActor", actor => {
  if (game.settings.get(ID, "enabled")) enqueue(actor);
});
for (const hook of ["createActiveEffect", "updateActiveEffect", "deleteActiveEffect"]) {
  Hooks.on(hook, effect => {
    if (effect.getFlag(ID, "automated")) return;
    if (game.settings.get(ID, "enabled") && effect.parent?.documentName === "Actor") enqueue(effect.parent);
  });
}
Hooks.on("preMoveToken", validateMovement);
