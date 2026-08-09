import { DatabaseSync } from 'node:sqlite';

/** Typed read-only access to the v1 production backup (SQLite).
 *
 * Reader choice (documented): Node 22.13+ ships `node:sqlite` built in —
 * it opens the backup read-only, needs no native build step and no new
 * dependency, and the repo already pins Node >= 22.13. The module is
 * still marked experimental upstream, but the surface the importer uses
 * (open read-only, prepare, all) has been stable across the 22.x line;
 * choosing it over a `better-sqlite3` devDependency is the smallest
 * honest choice. */

export interface V1Work {
  readonly id: string;
  readonly fileNo: string;
  readonly name: string;
  readonly zone: string;
  readonly division: string;
  readonly loaNo: string;
  readonly loaDate: string;
  readonly tenderIssuingAuthority: string;
  readonly caNo: string;
  readonly caDate: string;
  readonly totalCost: number;
  readonly pbgLoa: number;
  readonly pbgActual: number;
  readonly actualCompletionPeriod: string;
  readonly workExtensionPeriod: string;
  readonly pbgCompletionPeriod: string;
  readonly excelFilename: string;
  readonly contractorName: string;
}

export interface V1WorkItem {
  readonly id: string;
  readonly workId: string;
  readonly schedule: string;
  readonly srNo: number;
  readonly description: string;
  readonly unit: string;
  readonly qty: number;
  readonly variation: number;
  readonly rate: number;
  readonly agtRate: number;
  readonly total: number;
}

export interface V1ItemVariation {
  readonly id: string;
  readonly workItemId: string;
  readonly variationNo: number;
  readonly qty: number;
  readonly rate: number;
  readonly remark: string;
  readonly date: string;
  readonly createdAt: string;
  readonly source: string;
}

export interface V1Challan {
  readonly id: string;
  readonly typeId: number | null;
  readonly challanNo: string;
  readonly date: string;
  readonly to: string;
  readonly company: string;
  readonly remark: string;
  readonly workId: string;
  readonly createdAt: string;
  readonly siteEngineer: string;
  readonly status: string;
  readonly createdBy: string | null;
}

export interface V1ChallanItem {
  readonly id: string;
  readonly challanId: string;
  readonly itemId: string;
  readonly scheduleNo: string;
  readonly description: string;
  readonly unit: string;
  readonly qty: number;
  readonly variation: number;
  readonly rate: number;
  readonly remark: string;
  readonly warrantyQty: number | null;
  readonly serialNo: string;
}

export interface V1Backup {
  readonly works: V1Work[];
  readonly workItems: V1WorkItem[];
  readonly itemVariations: V1ItemVariation[];
  readonly challans: V1Challan[];
  readonly challanItems: V1ChallanItem[];
  readonly consignees: string[];
  readonly companies: string[];
  readonly users: Map<string, string>;
}

function rows<T>(db: DatabaseSync, sql: string): T[] {
  // node:sqlite returns objects with a null prototype; spread them into
  // plain objects so canonical JSON and structuredClone behave normally.
  return db
    .prepare(sql)
    .all()
    .map((row) => ({ ...(row as Record<string, unknown>) }) as T);
}

export function readV1Backup(path: string): V1Backup {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const works = rows<V1Work>(
      db,
      `select id, fileNo, name, zone, division,
              coalesce(loaNo, '') as loaNo, coalesce(loaDate, '') as loaDate,
              coalesce(tenderIssuingAuthority, '') as tenderIssuingAuthority,
              coalesce(caNo, '') as caNo, coalesce(caDate, '') as caDate,
              coalesce(totalCost, 0) as totalCost,
              coalesce(pbgLoa, 0) as pbgLoa, coalesce(pbgActual, 0) as pbgActual,
              coalesce(actualCompletionPeriod, '') as actualCompletionPeriod,
              coalesce(workExtensionPeriod, '') as workExtensionPeriod,
              coalesce(pbgCompletionPeriod, '') as pbgCompletionPeriod,
              coalesce(excelFilename, '') as excelFilename,
              coalesce(contractorName, '') as contractorName
       from works order by id`,
    );
    const workItems = rows<V1WorkItem>(
      db,
      `select id, workId, coalesce(schedule, '') as schedule, srNo,
              coalesce(description, '') as description, coalesce(unit, '') as unit,
              coalesce(qty, 0) as qty, coalesce(variation, 0) as variation,
              coalesce(rate, 0) as rate, coalesce(agtRate, 0) as agtRate,
              coalesce(total, 0) as total
       from work_items order by workId, schedule, srNo, id`,
    );
    const itemVariations = rows<V1ItemVariation>(
      db,
      `select id, workItemId, coalesce(variationNo, 0) as variationNo,
              coalesce(qty, 0) as qty, coalesce(rate, 0) as rate,
              coalesce(remark, '') as remark, coalesce(date, '') as date,
              coalesce(createdAt, '') as createdAt, coalesce(source, '') as source
       from item_variations order by workItemId, variationNo, id`,
    );
    const challans = rows<V1Challan>(
      db,
      `select id, typeId, challanNo, date, "to" as 'to',
              coalesce(company, '') as company, coalesce(remark, '') as remark,
              workId, coalesce(createdAt, '') as createdAt,
              coalesce(siteEngineer, '') as siteEngineer,
              coalesce(status, 'confirmed') as status, createdBy
       from delivery_challans order by workId, createdAt, id`,
    );
    const challanItems = rows<V1ChallanItem>(
      db,
      `select rowid, id, challanId, itemId, coalesce(scheduleNo, '') as scheduleNo,
              coalesce(description, '') as description, coalesce(unit, '') as unit,
              coalesce(qty, 0) as qty, coalesce(variation, 0) as variation,
              coalesce(rate, 0) as rate, coalesce(remark, '') as remark,
              warrantyQty, coalesce(serialNo, '') as serialNo
       from delivery_challan_items order by challanId, rowid`,
    ).map((row) => {
      const { rowid: _rowid, ...rest } = row as V1ChallanItem & { rowid: number };
      return rest;
    });
    const consignees = rows<{ name: string }>(
      db,
      'select name from consignees order by id',
    ).map((row) => row.name);
    const companies = rows<{ name: string }>(
      db,
      'select name from companies order by id',
    ).map((row) => row.name);
    const users = new Map(
      rows<{ id: string; username: string }>(
        db,
        'select id, username from users order by id',
      ).map((row) => [row.id, row.username]),
    );
    return {
      works,
      workItems,
      itemVariations,
      challans,
      challanItems,
      consignees,
      companies,
      users,
    };
  } finally {
    db.close();
  }
}
