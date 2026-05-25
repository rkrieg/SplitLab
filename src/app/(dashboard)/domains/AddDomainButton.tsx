'use client';

import { Globe } from 'lucide-react';
import toast from 'react-hot-toast';

export default function AddDomainButton() {
  return (
    <button
      onClick={() => toast('Please select a client from the sidebar first to add a domain.', { icon: '⚠️' })}
      className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold transition-colors"
    >
      <Globe size={14} /> Add Domain
    </button>
  );
}
