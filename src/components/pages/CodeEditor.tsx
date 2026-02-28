'use client';

import CodeMirror from '@uiw/react-codemirror';
import { html } from '@codemirror/lang-html';
import { oneDark } from '@codemirror/theme-one-dark';

interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  height?: string;
  readOnly?: boolean;
}

export default function CodeEditor({
  value,
  onChange,
  height = '300px',
  readOnly = false,
}: CodeEditorProps) {
  return (
    <div
      className="rounded-lg overflow-hidden border border-slate-600"
      style={{ fontSize: '13px' }}
    >
      <CodeMirror
        value={value}
        height={height}
        extensions={[html()]}
        theme={oneDark}
        onChange={onChange}
        readOnly={readOnly}
        basicSetup={{
          lineNumbers: true,
          foldGutter: true,
          highlightActiveLine: true,
          autocompletion: true,
          bracketMatching: true,
          closeBrackets: true,
          indentOnInput: true,
        }}
      />
    </div>
  );
}
