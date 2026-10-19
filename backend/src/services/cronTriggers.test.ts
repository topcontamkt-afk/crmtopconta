import { CRON_TRIGGERS, CRON_TRIGGERS_PAGO, jobsDoTrigger, runCronTrigger, type CronJob } from "./cronTriggers";
import { readFileSync } from "node:fs";
import { join } from "node:path";

jest.mock("./scheduler", () => ({}));

const em = (iso: string) => new Date(iso);

describe("jobsDoTrigger", () => {
  it("cada trigger roda os jobs do antigo vercel.json no mesmo horário", () => {
    expect(jobsDoTrigger("0 3 * * *", em("2026-10-19T03:00:00Z"))).toEqual(["retention", "bi-export"]);
    expect(jobsDoTrigger("0 6 * * *", em("2026-10-19T06:00:00Z"))).toEqual(["sheet-sync", "snapshot"]);
    expect(jobsDoTrigger("0 9-11 * * *", em("2026-10-19T09:00:00Z"))).toEqual(["dispatch"]);
    expect(jobsDoTrigger("0 9-11 * * *", em("2026-10-19T10:00:00Z"))).toEqual(["automations"]);
    expect(jobsDoTrigger("0 9-11 * * *", em("2026-10-19T11:00:00Z"))).toEqual(["segments-refresh"]);
  });

  it("hora fora da faixa ou trigger desconhecido não roda nada", () => {
    expect(jobsDoTrigger("0 9-11 * * *", em("2026-10-19T12:00:00Z"))).toEqual([]);
    expect(jobsDoTrigger("*/10 * * * *", em("2026-10-19T09:00:00Z"))).toEqual([]);
  });

  it("plano pago: cadências do servidor local", () => {
    expect(jobsDoTrigger("* * * * *", em("2026-10-19T14:07:00Z"))).toEqual(["dispatch", "sheet-sync", "segments-refresh"]);
    expect(jobsDoTrigger("*/5 * * * *", em("2026-10-19T14:05:00Z"))).toEqual(["automations"]);
    expect(jobsDoTrigger("0 3 * * *", em("2026-10-19T03:00:00Z"))).toEqual(["retention", "bi-export"]);
    expect(jobsDoTrigger("30 6 * * *", em("2026-10-19T06:30:00Z"))).toEqual(["snapshot"]);
  });

  it.each([
    ["grátis", CRON_TRIGGERS, ["2026-10-19T03:00:00Z", "2026-10-19T06:00:00Z", "2026-10-19T09:00:00Z", "2026-10-19T10:00:00Z", "2026-10-19T11:00:00Z"]],
    ["pago", CRON_TRIGGERS_PAGO, ["2026-10-19T03:00:00Z", "2026-10-19T06:30:00Z", "2026-10-19T14:05:00Z"]],
  ])("plano %s: os 7 jobs têm trigger", (_plano, triggers, horas) => {
    const todos = new Set((triggers as readonly string[]).flatMap((c) => horas.flatMap((h) => jobsDoTrigger(c, em(h)))));
    expect([...todos].sort()).toEqual(["automations", "bi-export", "dispatch", "retention", "segments-refresh", "sheet-sync", "snapshot"]);
  });

  it("cada ambiente do wrangler.jsonc usa um dos dois conjuntos inteiro (hoje o do grátis)", () => {
    // JSONC: tira os comentários de linha antes de ler
    const cfg = JSON.parse(readFileSync(join(__dirname, "../../wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/ .*$/gm, ""));
    expect(cfg.triggers.crons).toEqual([...CRON_TRIGGERS]);
    expect(cfg.env.hml.triggers.crons).toEqual([...CRON_TRIGGERS]);
    for (const amb of Object.values(cfg.env) as any[]) {
      expect([[...CRON_TRIGGERS], [...CRON_TRIGGERS_PAGO]]).toContainEqual(amb.triggers.crons);
    }
  });
});

describe("runCronTrigger", () => {
  const fakeRun = (falha?: CronJob) => {
    const chamadas: [CronJob, Date][] = [];
    const run = Object.fromEntries(
      (["retention", "bi-export", "sheet-sync", "snapshot", "dispatch", "automations", "segments-refresh"] as CronJob[]).map((job) => [
        job,
        async (now: Date) => {
          chamadas.push([job, now]);
          if (job === falha) throw new Error("falhou de propósito");
          return { job };
        },
      ])
    ) as Record<CronJob, (now: Date) => Promise<unknown>>;
    return { run, chamadas };
  };

  beforeEach(() => {
    jest.spyOn(console, "log").mockImplementation(() => undefined);
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it("roda em ordem, com o horário agendado, e a falha de um não impede o seguinte", async () => {
    const { run, chamadas } = fakeRun("sheet-sync");
    const agendado = em("2026-10-19T06:00:00Z");
    const r = await runCronTrigger("0 6 * * *", agendado, run);
    expect(chamadas).toEqual([
      ["sheet-sync", agendado],
      ["snapshot", agendado],
    ]);
    expect(r.map((x) => [x.job, x.ok, x.error])).toEqual([
      ["sheet-sync", false, "falhou de propósito"],
      ["snapshot", true, undefined],
    ]);
  });

  it("trigger sem job só avisa", async () => {
    const { run, chamadas } = fakeRun();
    expect(await runCronTrigger("0 0 * * *", em("2026-10-19T00:00:00Z"), run)).toEqual([]);
    expect(chamadas).toEqual([]);
    expect(console.warn).toHaveBeenCalled();
  });
});
