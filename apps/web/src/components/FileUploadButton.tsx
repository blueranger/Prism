'use client';

import { useRef, useState } from 'react';
import { uploadFile, createSession } from '@/lib/api';
import { useChatStore } from '@/stores/chat-store';
import { toast } from '@/stores/toast-store';
import type { UploadedFile } from '@prism/shared';

const ACCEPTED_TYPES = '.pdf,.png,.jpg,.jpeg,.webp,.gif,.docx,.xlsx,.pptx';
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB

interface FileUploadButtonProps {
  onUploaded: (file: UploadedFile) => void;
  disabled?: boolean;
}

export default function FileUploadButton({ onUploaded, disabled }: FileUploadButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<string | null>(null);

  const handleClick = () => {
    inputRef.current?.click();
  };

  const handleChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setUploading(true);

    // Ensure a session exists before uploading
    let sid = useChatStore.getState().sessionId;
    if (!sid) {
      setUploadProgress('Creating session...');
      sid = await createSession();
      if (sid) {
        useChatStore.getState().setSessionId(sid);
      } else {
        toast.error('Failed to create session. Please try again.');
        setUploading(false);
        setUploadProgress(null);
        return;
      }
    }

    const fileList = Array.from(files);
    let successCount = 0;
    let failCount = 0;

    for (const file of fileList) {
      // Client-side size check
      if (file.size > MAX_FILE_SIZE) {
        toast.error(`"${file.name}" exceeds 100MB limit.`);
        failCount++;
        continue;
      }

      setUploadProgress(`Uploading ${file.name}...`);

      const result = await uploadFile(sid, file);
      if (result) {
        onUploaded(result);
        successCount++;
      } else {
        toast.error(`Failed to upload "${file.name}".`);
        failCount++;
      }
    }

    // Show summary toast
    if (successCount > 0 && failCount === 0) {
      const msg = successCount === 1
        ? `"${fileList[0].name}" uploaded successfully.`
        : `${successCount} files uploaded successfully.`;
      toast.success(msg);
    } else if (successCount > 0 && failCount > 0) {
      toast.info(`${successCount} uploaded, ${failCount} failed.`);
    }
    // If all failed, individual error toasts already shown

    setUploading(false);
    setUploadProgress(null);

    // Reset the input so the same file can be selected again
    if (inputRef.current) {
      inputRef.current.value = '';
    }
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_TYPES}
        onChange={handleChange}
        className="hidden"
        multiple
      />
      <button
        type="button"
        onClick={handleClick}
        disabled={disabled || uploading}
        title={uploading ? (uploadProgress ?? 'Uploading...') : 'Upload a file (PDF, Office, image)'}
        className="relative text-gray-400 hover:text-gray-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed px-2 py-3"
      >
        {uploading ? (
          <div className="flex items-center gap-1.5">
            <span className="inline-block w-4 h-4 border-2 border-indigo-400 border-t-transparent rounded-full animate-spin" />
            {uploadProgress && (
              <span className="text-[10px] text-indigo-400 max-w-[120px] truncate">
                {uploadProgress}
              </span>
            )}
          </div>
        ) : (
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="w-5 h-5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13"
            />
          </svg>
        )}
      </button>
    </>
  );
}
