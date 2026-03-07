import type { Metadata } from 'next';
import './globals.css';
import ToastContainer from '@/components/ToastContainer';

export const metadata: Metadata = {
  title: 'Prism',
  description: 'Multi-LLM Orchestrator',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-gray-950 text-gray-100 min-h-screen">
        {children}
        <ToastContainer />
      </body>
    </html>
  );
}
