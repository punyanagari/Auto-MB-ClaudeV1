/** Tenant-mapping configuration for the v1 importer. The config names
 * every v1 company-name spelling and either maps it to a target
 * organisation or excludes it explicitly — an unmapped, un-excluded
 * spelling that carries data is a hard error, never a guess. */

export interface MappingOrganisation {
  readonly slug: string;
  readonly name: string;
}

export interface MappingConfig {
  /** Organisations the importer may create (idle: no memberships). */
  readonly organisations: readonly MappingOrganisation[];
  /** v1 company-name spelling -> target organisation slug. */
  readonly companyToOrganisation: Readonly<Record<string, string>>;
  /** v1 company names whose data is intentionally not imported. */
  readonly excludeCompanies: readonly string[];
}

const SLUG_SHAPE = /^[a-z0-9][a-z0-9-]{1,62}$/;

export function parseMappingConfig(raw: unknown): MappingConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('mapping config must be a JSON object');
  }
  const value = raw as Record<string, unknown>;
  const organisations = value.organisations;
  const companyToOrganisation = value.companyToOrganisation;
  const excludeCompanies = value.excludeCompanies ?? [];

  if (!Array.isArray(organisations) || organisations.length === 0) {
    throw new Error('mapping config: organisations[] is required');
  }
  const slugs = new Set<string>();
  const parsedOrganisations: MappingOrganisation[] = organisations.map((entry) => {
    const org = entry as Record<string, unknown>;
    if (typeof org.slug !== 'string' || !SLUG_SHAPE.test(org.slug)) {
      throw new Error(`mapping config: invalid organisation slug ${String(org.slug)}`);
    }
    if (typeof org.name !== 'string' || org.name.trim().length < 2) {
      throw new Error(`mapping config: invalid organisation name for ${org.slug}`);
    }
    if (slugs.has(org.slug)) {
      throw new Error(`mapping config: duplicate organisation slug ${org.slug}`);
    }
    slugs.add(org.slug);
    return { slug: org.slug, name: org.name };
  });

  if (typeof companyToOrganisation !== 'object' || companyToOrganisation === null) {
    throw new Error('mapping config: companyToOrganisation{} is required');
  }
  const parsedMap: Record<string, string> = {};
  for (const [company, slug] of Object.entries(
    companyToOrganisation as Record<string, unknown>,
  )) {
    if (typeof slug !== 'string' || !slugs.has(slug)) {
      throw new Error(
        `mapping config: company ${JSON.stringify(company)} maps to unknown organisation ${String(slug)}`,
      );
    }
    parsedMap[company] = slug;
  }

  if (!Array.isArray(excludeCompanies)) {
    throw new Error('mapping config: excludeCompanies must be an array');
  }
  const parsedExcludes = excludeCompanies.map((entry) => {
    if (typeof entry !== 'string') {
      throw new Error('mapping config: excludeCompanies entries must be strings');
    }
    if (entry in parsedMap) {
      throw new Error(
        `mapping config: ${JSON.stringify(entry)} is both mapped and excluded`,
      );
    }
    return entry;
  });

  return {
    organisations: parsedOrganisations,
    companyToOrganisation: parsedMap,
    excludeCompanies: parsedExcludes,
  };
}

export type CompanyResolution =
  | { readonly kind: 'organisation'; readonly slug: string }
  | { readonly kind: 'excluded' }
  | { readonly kind: 'unmapped' };

export function resolveCompany(
  mapping: MappingConfig,
  company: string,
): CompanyResolution {
  const slug = mapping.companyToOrganisation[company];
  if (slug !== undefined) return { kind: 'organisation', slug };
  if (mapping.excludeCompanies.includes(company)) return { kind: 'excluded' };
  return { kind: 'unmapped' };
}
