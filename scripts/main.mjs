const ID = "lipatos-encumbrance";
const TITLES = ["", "Нагрузка", "Сильная нагрузка", "Перегрузка"];
const DETAILS = [
  "",
  "Скорость перемещения уменьшается на 10 футов.",
  "Скорость перемещения уменьшается на 20 футов. Помеха на броски атаки, проверки характеристик и спасброски с использованием Силы, Ловкости или Телосложения.",
  "Скорость перемещения становится 0 футов. Помеха на броски атаки, проверки характеристик и спасброски с использованием Силы, Ловкости или Телосложения."
];
const EFFECT_ICONS = {
  1: "modules/lipatos-encumbrance/assets/icons/encumbrance-1.jpg",
  2: "modules/lipatos-encumbrance/assets/icons/encumbrance-2.jpg",
  3: "modules/lipatos-encumbrance/assets/icons/encumbrance-3.jpg"
};
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
    img: EFFECT_ICONS[tier],
    description: DETAILS[tier],
    disabled: false,
    transfer: false,
    changes: effectChanges(tier, actor),
    flags: {[ID]: {automated: true, tier}}
  };
  if (effect) {
    if (effect.getFlag(ID, "tier") !== tier || effect.disabled || effect.img !== payload.img || effect.name !== payload.name || effect.description !== payload.description) await effect.update(payload);
  } else {
    await actor.createEmbeddedDocuments("ActiveEffect", [payload]);
  }
}

function enqueue(actor) {
  const primaryGM = game.users.filter(u => u.active && u.isGM).sort((a, b) => a.id.localeCompare(b.id))[0];
  if (!actor || !game.user?.isGM || game.user.id !== primaryGM?.id || !actor.id || actor.type !== "character") return;
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
  if (game.user?.isGM || !game.settings.get(ID, "enabled")) return;
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

// ===========================================================================
// Overload roll-choice guard, Foundry v14 / D&D5e 6.0.x
// ===========================================================================

const RESTRICTED_ABILITIES = new Set(["str", "dex", "con"]);

/** Resolve the actor from a D&D5e roll-process subject (Actor or Activity). */
function actorFromRollSubject(subject) {
  if (subject?.documentName === "Actor") return subject;
  const actor = subject?.actor ?? subject?.item?.actor ?? subject?.parent?.actor;
  return actor?.documentName === "Actor" ? actor : null;
}

/** Shared check for rendering and actual roll enforcement. */
function forcedOverloadTier(process, ability) {
  if (game.user?.isGM || game.system?.id !== "dnd5e" || !game.settings.get(ID, "enabled")) return 0;
  const hooks = process?.hookNames ?? [];
  const isAttack = hooks.includes("attack");
  if (!isAttack && !hooks.includes("d20Test")) return 0;
  const tier = getTier(actorFromRollSubject(process.subject));
  if (tier < 2) return 0;
  // Under heavy encumbrance ALL attack rolls have disadvantage, including
  // ranged weapon and spell attacks using INT/WIS/CHA.
  // Only ability checks and saves are limited to STR/DEX/CON.
  if (isAttack) return tier;
  return RESTRICTED_ABILITIES.has(String(ability ?? "").toLowerCase()) ? tier : 0;
}

function dialogAbility(app, root) {
  // The ability dropdown can be changed while the roll dialog is open.
  const element = (app.form ?? root.querySelector("form"))?.elements?.namedItem("ability");
  return element?.value ?? app.config?.ability ?? "";
}

function toggleRollGuard(button, blocked, title) {
  let wrapper = button.parentElement?.classList?.contains("lipatos-enc-roll-choice")
    ? button.parentElement : null;
  if (blocked) {
    if (!wrapper) {
      wrapper = document.createElement("span");
      wrapper.className = "lipatos-enc-roll-choice";
      button.before(wrapper);
      wrapper.append(button);
    }
    wrapper.title = title;
    wrapper.setAttribute("data-tooltip", title);
    wrapper.setAttribute("aria-label", title);
    wrapper.tabIndex = 0;
    button.disabled = true;
    button.setAttribute("aria-disabled", "true");
    button.removeAttribute("autofocus");
    button.classList.add("lipatos-enc-roll-disabled");
  } else {
    button.disabled = false;
    button.removeAttribute("aria-disabled");
    button.classList.remove("lipatos-enc-roll-disabled");
    if (wrapper) wrapper.replaceWith(button);
  }
}

function updateRollGuardUI(app, root) {
  if (!app?.config || !root?.querySelector) return;
  const buttonRow = root.querySelector(".dialog-buttons");
  if (!buttonRow?.querySelector('button[data-action="disadvantage"]')) return;

  const tier = forcedOverloadTier(app.config, dialogAbility(app, root));
  const title = tier ? TITLES[tier] : "";
  for (const action of ["normal", "advantage"]) {
    const button = buttonRow.querySelector('button[data-action="' + action + '"]');
    if (button) toggleRollGuard(button, !!tier, title);
  }
  const dis = buttonRow.querySelector('button[data-action="disadvantage"]');
  if (dis && tier) {
    dis.removeAttribute("disabled");
    dis.disabled = false;
    dis.setAttribute("autofocus", "");
  }
  buttonRow.classList.toggle("lipatos-enc-roll-forced", !!tier);
  if (tier) buttonRow.dataset.overload = title;
  else delete buttonRow.dataset.overload;
}

function attachRollGuardUI(app, html) {
  const root = html instanceof HTMLElement ? html : html?.[0] instanceof HTMLElement ? html[0] : app?.element;
  if (!(root instanceof HTMLElement)) return;
  // D&D5e V2 config application exposes .config.subject and the three standard d20 buttons.
  if (!app?.config?.hookNames?.includes("d20Test")) return;
  if (!root.querySelector('.dialog-buttons button[data-action="disadvantage"]')) return;
  if (!root.dataset.lipatosEncRollListening) {
    root.dataset.lipatosEncRollListening = "1";
    root.addEventListener("change", event => {
      if (event.target?.name === "ability") updateRollGuardUI(app, root);
    });
  }
  updateRollGuardUI(app, root);
}

/**
 * D&D5e public post-configuration hook: runs even for Shift/Alt/Ctrl fast-forward,
 * after button choice has been turned into a D20Roll but before evaluation.
 */
/**
 * Native D&D5e 6.x hook, called after AttackActivity._buildAttackConfig and
 * the other D20 builder callbacks, immediately before D20Roll.fromConfig().
 * This covers regular dialogs, fast-forward keybinds and Argon HUD attacks.
 */
function enforceOverloadConfig(process, rollConfig, index, {formData} = {}) {
  const ability = formData?.get?.("ability") ?? rollConfig?.options?.ability
    ?? rollConfig?.data?.roll?.ability ?? process?.ability;
  if (!forcedOverloadTier(process, ability)) return;
  rollConfig.options ??= {};
  rollConfig.options.advantageMode = CONFIG.Dice.D20Roll.ADV_MODE.DISADVANTAGE;
  rollConfig.options.advantage = false;
  rollConfig.options.disadvantage = true;
}

/** Additional last-chance protection after rolls are constructed. */
function enforceOverloadRoll(rolls, process) {
  if (!Array.isArray(rolls)) return;
  for (const roll of rolls) {
    const ability = roll?.options?.ability ?? roll?.data?.abilityId
      ?? roll?.data?.roll?.ability ?? process?.ability;
    if (!forcedOverloadTier(process, ability)) continue;
    if (!roll?.d20?.applyAdvantage || !roll?.resetFormula) continue;
    roll.options.advantageMode = CONFIG.Dice.D20Roll.ADV_MODE.DISADVANTAGE;
    roll.options.advantage = false;
    roll.options.disadvantage = true;
    roll.d20.applyAdvantage(CONFIG.Dice.D20Roll.ADV_MODE.DISADVANTAGE);
    roll.resetFormula();
  }
}

Hooks.on("renderApplicationV2", attachRollGuardUI);
Hooks.on("dnd5e.postBuildD20TestRollConfig", enforceOverloadConfig);
Hooks.on("dnd5e.postD20TestRollConfiguration", enforceOverloadRoll);


// ---------------------------------------------------------------------------
// Argon Combat HUD (CORE + DND5E) / native dnd5e Dash integrations.
// Argon's synthetic "Dash" posts a chat card and consumes an action; it does
// not itself modify the movement budget. Listen for that *specific* card only.
// ---------------------------------------------------------------------------
const pendingDash = new Set();
const DASH_ICON = "modules/enhancedcombathud/icons/walking-boot.webp";

function isDashName(name) {
  const normalized = String(name ?? "").trim().toLocaleLowerCase();
  if (!normalized) return false;
  const localized = game.i18n?.localize?.("enhancedcombathud-dnd5e.items.dash.name");
  return [localized, "Dash", "Рывок"].some(label =>
    normalized === String(label ?? "").trim().toLocaleLowerCase());
}

/** Resolve the token currently taking the turn. Other combatants never get the bonus. */
function dashTokenForActor(actorId, speakerTokenId = null) {
  const c = game.combat?.combatant;
  if (!game.combat?.started || !c) return null;
  let token = c.token ?? c.actor?.token;
  if (token?.document) token = token.document;
  const actor = token?.actor ?? c.actor;
  if (!actor || (actorId && actor.id !== actorId && c.actor?.id !== actorId)) return null;
  if (speakerTokenId && token?.id && speakerTokenId !== token.id) return null;
  if (token?.documentName === "Token" && token.isOwner) return token;
  const argonToken = ui.ARGON?._token?.document;
  if (argonToken?.id === c.tokenId && argonToken?.isOwner) return argonToken;
  return null;
}

function syncArgonDashAction(document) {
  try {
    if (ui.ARGON?._actor?.id !== document.actor?.id) return;
    const actionPanel = ui.ARGON.components?.main?.[0];
    if (actionPanel) {
      actionPanel.isActionUsed = true;
      actionPanel.updateActionUse?.();
    }
    ui.ARGON.components?.movement?.updateMovement?.();
  } catch (error) {
    console.warn("LipatoS Encumbrance: Argon HUD could not refresh its action indicator", error);
  }
}

async function registerExternalDash(document) {
  if (!document?.uuid || pendingDash.has(document.uuid) || !canDash(document)) return false;
  pendingDash.add(document.uuid);
  try {
    const applied = await useDash(document);
    if (applied) syncArgonDashAction(document);
    return applied;
  } catch (error) {
    console.error("LipatoS Encumbrance: could not register Dash", error);
    ui.notifications.error("Не удалось учесть Рывок в перемещении.");
    return false;
  } finally {
    pendingDash.delete(document.uuid);
  }
}

/** Ignore other chat cards: only Argon's synthetic special action has this icon. */
function isArgonSyntheticDash(message) {
  const content = String(message?.content ?? "");
  if (!content.includes(DASH_ICON) || !content.includes("dnd5e2 chat-card item-card")) return false;
  const title = content.match(/<span\s+class=["']title["']>([^<]*)<\/span>/i)?.[1];
  return isDashName(title);
}

Hooks.on("createChatMessage", (message, options, userId) => {
  if (!game.modules.get("enhancedcombathud-dnd5e")?.active) return;
  if (game.user?.isGM || !game.settings.get(ID, "enabled")) return;
  const authorId = message.user?.id ?? message.user ?? userId;
  if (authorId !== game.user.id || !isArgonSyntheticDash(message)) return;
  const actorId = message.speaker?.actor?.id ?? message.speaker?.actor;
  const speakerTokenId = typeof message.speaker?.token === "string" ? message.speaker.token : message.speaker?.token?.id;
  const token = dashTokenForActor(actorId, speakerTokenId);
  if (token) void registerExternalDash(token);
});

/** Owned Dash features can be activities and skip Argon's synthetic chat card. */
Hooks.on("dnd5e.postUseActivity", (activity) => {
  if (game.user?.isGM || !game.settings.get(ID, "enabled")) return;
  if (!game.modules.get("enhancedcombathud-dnd5e")?.active) return;
  const item = activity?.item;
  if (!item || item.type !== "feat" || !isDashName(item.name)) return;
  if (activity.activation?.type !== "action") return;
  const token = dashTokenForActor(item.actor?.id ?? item.parent?.id);
  if (token) void registerExternalDash(token);
});
