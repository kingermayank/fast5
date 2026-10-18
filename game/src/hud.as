// The screens and HUD (ui.rml) are bound to the Game view model (data.rml).
// This holds a handle on each property, writes it only when the value changes,
// and times the banners and radio lines that come and go.
import { ViewModel, PropertyNumber, PropertyString, PropertyBoolean, PropertyColor, PropertyTrigger, PropertyEnum } from "rive/data";
import { Color } from "rive/color";

/** Set when the UI fires `confirm` (a click on a crew card); the game takes it. */
let confirmFired = false;

/** 1234567 as "1,234,567". */
export function thousands(n: f64): string {
  let s = (<i64>Math.round(Math.abs(n))).toString();
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 == 0) out += ",";
    out += s.charAt(i);
  }
  return n < 0 ? "-" + out : out;
}

export function money(n: f64): string {
  return "$" + thousands(n);
}

/** Seconds as "3:58.2". */
export function clockTime(t: f64): string {
  let m = <i32>Math.floor(t / 60);
  let s = t - <f64>m * 60;
  let whole = <i32>Math.floor(s);
  let tenth = <i32>Math.floor((s - <f64>whole) * 10);
  return m.toString() + ":" + (whole < 10 ? "0" : "") + whole.toString() + "." + tenth.toString();
}

export class Num {
  p: PropertyNumber? = null;
  last: f64 = NaN;

  constructor(vm: ViewModel, name: string) {
    this.p = vm.getNumber(name);
  }

  set(v: f64): void {
    if (v == this.last) return;
    this.last = v;
    let p = this.p;
    if (p != null) p.value = v;
  }

  /** For a value the UI also changes (the crew card on hover): always write it. */
  force(v: f64): void {
    this.last = v;
    let p = this.p;
    if (p != null) p.value = v;
  }

  read(): f64 {
    let p = this.p;
    return p != null ? p.value : 0;
  }
}

export class Str {
  p: PropertyString? = null;
  last: string = "\u0000";

  constructor(vm: ViewModel, name: string) {
    this.p = vm.getString(name);
  }

  set(v: string): void {
    if (v == this.last) return;
    this.last = v;
    let p = this.p;
    if (p != null) p.value = v;
  }
}

export class Bool {
  p: PropertyBoolean? = null;
  last: i32 = -1;

  constructor(vm: ViewModel, name: string) {
    this.p = vm.getBoolean(name);
  }

  set(v: bool): void {
    let i: i32 = v ? 1 : 0;
    if (i == this.last) return;
    this.last = i;
    let p = this.p;
    if (p != null) p.value = v;
  }
}

export class Col {
  p: PropertyColor? = null;
  last: u32 = 0;
  known: bool = false;

  constructor(vm: ViewModel, name: string) {
    this.p = vm.getColor(name);
  }

  set(v: Color): void {
    if (this.known && v == this.last) return;
    this.known = true;
    this.last = v;
    let p = this.p;
    if (p != null) p.value = v;
  }
}

export class Hud {
  // Screens.
  private screenProp: PropertyEnum? = null;
  private screenNow: string = "";
  crew: Num;
  selectPrompt: Str;
  // Driving HUD.
  speed: Num;
  speedText: Str;
  nos: Num;
  heat: Num;
  busted: Num;
  style: Str;
  damage: Str;
  wrecked: Str;
  objective: Str;
  guidance: Str;
  arrowOn: Bool;
  arrowAngle: Num;
  meterOn: Bool;
  meterLabel: Str;
  meterValue: Num;
  meterPrompt: Str;
  hint: Str;
  // Banners, radio, cutscenes, end screens.
  bannerTitle: Str;
  bannerSub: Str;
  bannerOn: Bool;
  radioWho: Str;
  radioText: Str;
  radioOn: Bool;
  subtitleWho: Str;
  subtitleText: Str;
  titleCard: Str;
  resultTitle: Str;
  resultBody: Str;
  resultPrompt: Str;
  // The cables: [0] the player's, [1] the partner's.
  cableName: StaticArray<Str>;
  cableBar: StaticArray<Num>;
  cableColor: StaticArray<Col>;
  cableHp: StaticArray<Num>;
  cableText: StaticArray<Str>;
  cablesAlpha: Num;
  tuneText: Str;
  tuneAlpha: Num;
  // For the page's sound.
  vaultSpeed: Num;
  vaultGrind: Num;
  throttle: Num;
  slip: Num;
  nosOn: Num;
  crashCount: Num;
  crashPower: Num;
  snapCount: Num;
  jerkCount: Num;
  siren: Num;
  // Test switches.
  autopilot: Num;
  headless: Num;

  private bannerTrigger: PropertyTrigger? = null;
  private radioTrigger: PropertyTrigger? = null;
  bannerLeft: f64 = 0;
  radioLeft: f64 = 0;

  constructor(vm: ViewModel) {
    this.screenProp = vm.getEnum("screen");
    this.crew = new Num(vm, "crew");
    this.selectPrompt = new Str(vm, "selectPrompt");
    this.speed = new Num(vm, "speed");
    this.speedText = new Str(vm, "speedText");
    this.nos = new Num(vm, "nos");
    this.heat = new Num(vm, "heat");
    this.busted = new Num(vm, "busted");
    this.style = new Str(vm, "style");
    this.damage = new Str(vm, "damage");
    this.wrecked = new Str(vm, "wrecked");
    this.objective = new Str(vm, "objective");
    this.guidance = new Str(vm, "guidance");
    this.arrowOn = new Bool(vm, "arrowOn");
    this.arrowAngle = new Num(vm, "arrowAngle");
    this.meterOn = new Bool(vm, "meterOn");
    this.meterLabel = new Str(vm, "meterLabel");
    this.meterValue = new Num(vm, "meterValue");
    this.meterPrompt = new Str(vm, "meterPrompt");
    this.hint = new Str(vm, "hint");
    this.bannerTitle = new Str(vm, "bannerTitle");
    this.bannerSub = new Str(vm, "bannerSub");
    this.bannerOn = new Bool(vm, "bannerOn");
    this.radioWho = new Str(vm, "radioWho");
    this.radioText = new Str(vm, "radioText");
    this.radioOn = new Bool(vm, "radioOn");
    this.subtitleWho = new Str(vm, "subtitleWho");
    this.subtitleText = new Str(vm, "subtitleText");
    this.titleCard = new Str(vm, "titleCard");
    this.resultTitle = new Str(vm, "resultTitle");
    this.resultBody = new Str(vm, "resultBody");
    this.resultPrompt = new Str(vm, "resultPrompt");
    this.cableName = [new Str(vm, "cableAName"), new Str(vm, "cableBName")];
    this.cableBar = [new Num(vm, "cableABar"), new Num(vm, "cableBBar")];
    this.cableColor = [new Col(vm, "cableAColor"), new Col(vm, "cableBColor")];
    this.cableHp = [new Num(vm, "cableAHp"), new Num(vm, "cableBHp")];
    this.cableText = [new Str(vm, "cableAText"), new Str(vm, "cableBText")];
    this.cablesAlpha = new Num(vm, "cablesAlpha");
    this.tuneText = new Str(vm, "tuneText");
    this.tuneAlpha = new Num(vm, "tuneAlpha");
    this.vaultSpeed = new Num(vm, "vaultSpeed");
    this.vaultGrind = new Num(vm, "vaultGrind");
    this.throttle = new Num(vm, "throttle");
    this.slip = new Num(vm, "slip");
    this.nosOn = new Num(vm, "nosOn");
    this.crashCount = new Num(vm, "crashCount");
    this.crashPower = new Num(vm, "crashPower");
    this.snapCount = new Num(vm, "snapCount");
    this.jerkCount = new Num(vm, "jerkCount");
    this.siren = new Num(vm, "siren");
    this.autopilot = new Num(vm, "autopilot");
    this.headless = new Num(vm, "headless");
    this.bannerTrigger = vm.getTrigger("banner");
    this.radioTrigger = vm.getTrigger("radio");
    let confirm = vm.getTrigger("confirm");
    if (confirm != null) confirm.addListener((): void => {
      confirmFired = true;
    });
  }

  /** True once after the UI's confirm trigger fired. */
  takeConfirm(): bool {
    let c = confirmFired;
    confirmFired = false;
    return c;
  }

  screen(name: string): void {
    if (name == this.screenNow) return;
    this.screenNow = name;
    let p = this.screenProp;
    if (p != null) p.value = name;
  }

  /** A banner for a few seconds (`BANK JOB`, `+$2,500,000`). */
  banner(title: string, sub: string, seconds: f64 = 3): void {
    this.bannerTitle.set(title);
    this.bannerSub.set(sub);
    this.bannerOn.set(true);
    this.bannerLeft = seconds;
    let t = this.bannerTrigger;
    if (t != null) t.fire();
  }

  /** A line on the crew's radio, shown for a time that suits its length. */
  radio(who: string, text: string): void {
    this.radioWho.set(who);
    this.radioText.set(text);
    this.radioOn.set(true);
    this.radioLeft = Math.max(3.5, 1.5 + <f64>text.length * 0.055);
    let t = this.radioTrigger;
    if (t != null) t.fire();
  }

  update(dt: f64): void {
    if (this.bannerLeft > 0) {
      this.bannerLeft -= dt;
      if (this.bannerLeft <= 0) this.bannerOn.set(false);
    }
    if (this.radioLeft > 0) {
      this.radioLeft -= dt;
      if (this.radioLeft <= 0) this.radioOn.set(false);
    }
  }
}
