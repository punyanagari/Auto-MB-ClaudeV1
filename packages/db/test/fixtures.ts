export interface TestOrganisation {
  readonly id: string;
  readonly name: string;
}

export const organisationA: TestOrganisation = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Test Organisation A',
};

export const organisationB: TestOrganisation = {
  id: '00000000-0000-4000-8000-000000000002',
  name: 'Test Organisation B',
};
