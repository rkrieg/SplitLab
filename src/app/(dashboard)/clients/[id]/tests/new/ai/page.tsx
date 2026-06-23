import { redirect } from 'next/navigation';
export default function AIGeneratePage({ params }: { params: { id: string } }) {
  redirect(`/clients/${params.id}/pages`);
}
