import { Type, type Static } from '@sinclair/typebox';
import { UuidSchema } from './primitives.js';

export const MembershipRoleSchema = Type.Union([
  Type.Literal('owner'),
  Type.Literal('office'),
  Type.Literal('site'),
  Type.Literal('viewer'),
]);
export type MembershipRole = Static<typeof MembershipRoleSchema>;

export const WorkScopeSchema = Type.Union([
  Type.Literal('all'),
  Type.Literal('assigned'),
]);
export type WorkScope = Static<typeof WorkScopeSchema>;

export const OrganisationSchema = Type.Object(
  {
    id: UuidSchema,
    name: Type.String({ minLength: 2, maxLength: 200 }),
    slug: Type.String({ pattern: '^[a-z0-9][a-z0-9-]{1,62}$' }),
  },
  { additionalProperties: false },
);
export type Organisation = Static<typeof OrganisationSchema>;

export const MembershipSchema = Type.Object(
  {
    organisationId: UuidSchema,
    userId: Type.String({ minLength: 1 }),
    role: MembershipRoleSchema,
    workScope: WorkScopeSchema,
    canIssueDocuments: Type.Boolean(),
    canCancelDocuments: Type.Boolean(),
    status: Type.Union([
      Type.Literal('invited'),
      Type.Literal('active'),
      Type.Literal('disabled'),
    ]),
  },
  { additionalProperties: false },
);
export type Membership = Static<typeof MembershipSchema>;

export const CreateOrganisationRequestSchema = Type.Object(
  {
    name: Type.String({ minLength: 2, maxLength: 200 }),
    slug: Type.String({ pattern: '^[a-z0-9][a-z0-9-]{1,62}$' }),
  },
  { additionalProperties: false },
);
export type CreateOrganisationRequest = Static<typeof CreateOrganisationRequestSchema>;

export const AddMemberRequestSchema = Type.Object(
  {
    email: Type.String({ minLength: 3, maxLength: 320 }),
    role: MembershipRoleSchema,
    workScope: Type.Optional(WorkScopeSchema),
    canIssueDocuments: Type.Optional(Type.Boolean()),
    canCancelDocuments: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type AddMemberRequest = Static<typeof AddMemberRequestSchema>;

export const OrganisationListResponseSchema = Type.Object(
  {
    organisations: Type.Array(OrganisationSchema),
  },
  { additionalProperties: false },
);
export type OrganisationListResponse = Static<typeof OrganisationListResponseSchema>;

export const MemberListResponseSchema = Type.Object(
  {
    members: Type.Array(MembershipSchema),
  },
  { additionalProperties: false },
);
export type MemberListResponse = Static<typeof MemberListResponseSchema>;
