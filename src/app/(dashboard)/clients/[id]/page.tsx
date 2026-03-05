import { redirect } from 'next/navigation';

export default function ClientDetailPage({ params }: { params: { id: string } }) {
  redirect(`/clients/${params.id}/pages`);
}
