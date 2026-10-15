/**
 * LipatoS Encumbrance: Argon Combat HUD stale reference repair.
 * Never grants ownership or bypasses Foundry's activity permission checks.
 * An Argon button may retain a weapon/activity from the previously selected actor
 * when the HUD rebinds to a synthetic combatant; re-resolve against the owned actor.
 */
const SCOPE = "lipatos-encumbrance";
const repaired = new WeakSet();
const patchedHUD = new WeakSet();
const warned = new Set();

function ownerActor(hud) {
  const hudActor = hud?._actor;
  const tokenActor = hud?._token?.actor ?? hud?._token?.document?.actor;
  // Don't allow an item lookup in a different actor than the currently bound HUD.
  if (hudActor && tokenActor && hudActor.uuid !== tokenActor.uuid) return null;
  return tokenActor ?? hudActor ?? null;
}

function originalItemReference(button) {
  const activity = button?._item;
  return activity?.item?.documentName === "Item" ? activity.item : button?.item;
}

function findOwnedItem(actor, supplied) {
  if (!actor?.isOwner || !supplied?.id) return null;
  const byId = actor.items?.get?.(supplied.id);
  if (byId?.isOwner && byId.type === supplied.type) return byId;
  // Use name fallback only if there is exactly one matching item, not for ambiguous names.
  const candidates = [...(actor.items ?? [])].filter(x =>
    x?.isOwner && x.type === supplied.type &&
    x.name === supplied.name
  );
  return candidates.length === 1 ? candidates[0] : null;
}

function itemForButton(button, owned) {
  const stored = button?._item;
  if (stored?.item?.documentName === "Item" && !stored?.system?.activities) {
    return owned.system?.activities?.get?.(stored.id) ?? null;
  }
  return owned;
}

function showOwnershipError(actor, item) {
  const key = [actor?.uuid ?? "unknown", item?.id ?? "unknown"].join(":");
  if (warned.has(key)) return;
  warned.add(key);
  const actorName = actor?.name ?? "выбранного персонажа";
  if (!actor?.isOwner) {
    ui.notifications.error(
      'Нельзя использовать предмет: нет прав «Владелец» у персонажа «' + actorName +
      '». ГМ должен назначить игроку владение этим персонажем (включая копию токена).'
    );
  } else {
    ui.notifications.error(
      'Argon HUD не смог найти принадлежащую персонажу «' + actorName +
      '» копию предмета «' + (item?.name ?? "неизвестно") + '». Перевыберите токен или обновите HUD.'
    );
  }
  console.warn(SCOPE + ": Argon item ownership check", {
    actor: actor?.uuid, actorOwner: actor?.isOwner, item: item?.uuid,
    itemOwner: item?.isOwner, activeToken: ui.ARGON?._token?.id
  });
}

function patchButton(button, hud) {
  if (!button || repaired.has(button) || typeof button._onLeftClick !== "function") return;
  // This applies to Argon buttons backed by D&D5e items or activities, not special buttons.
  if (!("_item" in button)) return;
  repaired.add(button);
  const original = button._onLeftClick;
  button._onLeftClick = async function(event) {
    if (game.user?.isGM || game.system?.id !== "dnd5e" || !game.settings.get(SCOPE, "enabled")) {
      return original.call(this, event);
    }
    const actor = ownerActor(hud);
    const item = originalItemReference(this);
    if (!item || item.documentName !== "Item") return original.call(this, event);
    if (actor?.isOwner && item.isOwner && item.actor?.uuid === actor.uuid) {
      return original.call(this, event);
    }
    const owned = findOwnedItem(actor, item);
    const correct = owned && itemForButton(this, owned);
    if (!correct || !owned.isOwner) {
      showOwnershipError(actor, item);
      return;
    }
    const previously = this._item;
    this._item = correct;
    try {
      return await original.call(this, event);
    } finally {
      // Retain a verified, owned reference to avoid repeating the error.
      if (this._item !== correct) this._item = previously;
    }
  };
}

function patchHUD(hud) {
  if (!hud || patchedHUD.has(hud)) return;
  patchedHUD.add(hud);
  for (const button of hud.itemButtons ?? []) patchButton(button, hud);
  const prev = hud.addItemButtons;
  if (typeof prev === "function") {
    hud.addItemButtons = function(buttons) {
      const value = prev.call(this, buttons);
      for (const btn of Array.isArray(buttons) ? buttons : [buttons]) patchButton(btn, this);
      return value;
    };
  }
}

Hooks.on("argonInit", CoreHud => {
  // Patch the actual HUD instance during registration without importing Argon internals.
  if (!CoreHud?.prototype || CoreHud.prototype._lipatosOwnershipPatch) return;
  CoreHud.prototype._lipatosOwnershipPatch = true;
  const original = CoreHud.prototype.addItemButtons;
  if (typeof original !== "function") return;
  CoreHud.prototype.addItemButtons = function(buttons) {
    const result = original.call(this, buttons);
    for (const button of Array.isArray(buttons) ? buttons : [buttons]) patchButton(button, this);
    return result;
  };
});
Hooks.once("ready", () => {
  if (game.system.id !== "dnd5e") return;
  patchHUD(ui.ARGON);
});
