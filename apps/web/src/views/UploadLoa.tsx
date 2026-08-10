import { useState, type FormEvent } from 'react';
import type { LoaDocumentDetail } from '@auto-mb/contracts';
import { RequestFailedError, type ApiClient } from '../api.js';
import { Button } from '../ui/button.js';
import { Card } from '../ui/card.js';
import { Field, Actions, FormError } from '../ui/form.js';

interface UploadLoaProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly onUploaded: (document: LoaDocumentDetail) => void;
  readonly onCancel: () => void;
}

export function UploadLoa({
  api,
  organisationId,
  onUploaded,
  onCancel,
}: UploadLoaProps) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = event.currentTarget.elements.namedItem('loa-file');
    const file = input instanceof HTMLInputElement ? (input.files?.[0] ?? null) : null;
    if (file === null) {
      setError('Choose the Letter of Acceptance PDF first.');
      return;
    }
    setPending(true);
    setError(null);
    try {
      const document = await api.uploadLoa(organisationId, file, file.name);
      onUploaded(document);
    } catch (cause) {
      setError(
        cause instanceof RequestFailedError
          ? cause.message
          : 'The upload failed. Check the connection and try again.',
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <Card aria-labelledby="upload-title">
      <h1 id="upload-title" tabIndex={-1}>
        Upload Letter of Acceptance
      </h1>
      <p className="text-muted-foreground">
        The PDF is stored privately for your organisation; its text is extracted and
        parsed for review. Nothing becomes a Work until you confirm it.
      </p>
      <form onSubmit={(event) => void upload(event)}>
        <Field>
          <label htmlFor="loa-file">LOA PDF</label>
          <input
            id="loa-file"
            name="loa-file"
            type="file"
            accept="application/pdf"
            required
          />
        </Field>

        {error !== null && <FormError>{error}</FormError>}

        <Actions>
          <Button type="submit" disabled={pending}>
            {pending ? 'Uploading…' : 'Upload and extract'}
          </Button>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        </Actions>
      </form>
    </Card>
  );
}
