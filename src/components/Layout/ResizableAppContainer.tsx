import React, { useEffect } from 'react';

interface ResizableAppContainerProps {
  children: React.ReactNode;
}

export const ResizableAppContainer: React.FC<ResizableAppContainerProps> = ({ children }) => {
  useEffect(() => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    if (!meta) return;

    meta.content = 'width=device-width, initial-scale=1.0, viewport-fit=cover';
  }, []);

  return (
    <div className="w-screen h-screen overflow-hidden flex flex-col">
      {children}
    </div>
  );
};
