import React, { useState, useEffect } from 'react';
import { FolderOpen, Image, Download, SplitSquareHorizontal as SplitHorizontal } from 'lucide-react';
import { ReactCompareSlider, ReactCompareSliderImage } from 'react-compare-slider';

interface FileInfo {
  name: string;
  handle: FileSystemHandle;
}

interface FileDetails {
  name: string;
  handle: FileSystemHandle;
  original: string;
  originalSize: number;
  compressed: string | null;
  compressedSize?: number;
  width?: number;
  height?: number;
}

// IndexedDB wrapper for storing directory handle
const DB_NAME = 'FileViewerDB';
const STORE_NAME = 'directoryHandles';
const DB_VERSION = 1;

async function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
  });
}

async function storeDirectoryHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.put(handle, 'lastDirectory');
    
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    
    transaction.oncomplete = () => db.close();
  });
}

async function getStoredDirectoryHandle(): Promise<FileSystemDirectoryHandle | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get('lastDirectory');
    
    request.onsuccess = async () => {
      const handle = request.result as FileSystemDirectoryHandle;
      if (!handle) {
        resolve(null);
        return;
      }
      
      try {
        const permission = await handle.requestPermission({ mode: 'read' });
        resolve(permission === 'granted' ? handle : null);
      } catch (error) {
        console.error('Permission verification failed:', error);
        resolve(null);
      }
    };
    
    request.onerror = () => {
      console.error('Error retrieving directory handle:', request.error);
      resolve(null);
    };
    
    transaction.oncomplete = () => db.close();
  });
}

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];

const compressImage = async (file: File, quality: number, format: string, outputSize: number): Promise<{ blob: Blob; width: number; height: number }> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const img = new window.Image();
    
    reader.onload = (e) => {
      if (e.target?.result) {
        img.src = e.target.result as string;
      }
    };

    img.onload = () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      
      if (!ctx) {
        reject(new Error('Could not get canvas context'));
        return;
      }

      // Calculate dimensions based on output size percentage
      let width = Math.round((img.width * outputSize) / 100);
      let height = Math.round((img.height * outputSize) / 100);
      
      // Ensure minimum dimensions
      width = Math.max(width, 1);
      height = Math.max(height, 1);

      canvas.width = width;
      canvas.height = height;
      
      // Use better quality scaling
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      
      ctx.drawImage(img, 0, 0, width, height);

      canvas.toBlob(
        (blob) => {
          if (blob) {
            resolve({ blob, width, height });
          } else {
            reject(new Error('Failed to compress image'));
          }
        },
        `image/${format}`,
        quality
      );
    };

    img.onerror = () => {
      reject(new Error('Failed to load image'));
    };

    reader.onerror = () => {
      reject(new Error('Failed to read file'));
    };

    reader.readAsDataURL(file);
  });
};

function App() {
  const [directoryHandle, setDirectoryHandle] = useState<FileSystemDirectoryHandle | null>(null);
  const [files, setFiles] = useState<FileInfo[]>([]);
  const [status, setStatus] = useState<string>('');
  const [selectedFile, setSelectedFile] = useState<FileDetails | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [viewMode, setViewMode] = useState<'preview' | 'compare'>('preview');
  const [quality, setQuality] = useState(0.8);
  const [format, setFormat] = useState<string>('webp');
  const [outputSize, setOutputSize] = useState(100);

  const getFiles = async (dirHandle: FileSystemDirectoryHandle) => {
    const files: FileInfo[] = [];
    try {
      for await (const entry of dirHandle.values()) {
        if (entry.kind === 'file' && IMAGE_EXTENSIONS.some(ext => 
          entry.name.toLowerCase().endsWith(ext))) {
          files.push({ name: entry.name, handle: entry });
        }
      }
    } catch (error) {
      console.error('Error reading directory contents:', error);
      setStatus('Error reading directory contents. Please try selecting the directory again.');
    }
    return files;
  };

  const handleSelectDirectory = async () => {
    try {
      setIsLoading(true);
      const options: DirectoryPickerOptions = {
        mode: 'read'
      };

      const lastDirHandle = await getStoredDirectoryHandle();
      if (lastDirHandle) {
        options.startIn = lastDirHandle;
      }

      const dirHandle = await window.showDirectoryPicker(options);
      const permission = await dirHandle.requestPermission({ mode: 'read' });
      if (permission !== 'granted') {
        throw new Error('Permission denied');
      }

      await storeDirectoryHandle(dirHandle);
      setDirectoryHandle(dirHandle);
      
      const filesInDir = await getFiles(dirHandle);
      setFiles(filesInDir);
      setStatus('Directory selected successfully');
      setSelectedFile(null);
    } catch (err) {
      if (err instanceof Error) {
        if (err.name === 'AbortError') {
          setStatus('Directory selection cancelled');
        } else if (err.message === 'Permission denied') {
          setStatus('Permission was denied to access the directory');
        } else {
          setStatus('An error occurred while selecting the directory');
        }
        console.error('Directory selection error:', err);
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleFileSelect = async (file: FileInfo) => {
    try {
      if (file.handle.kind === 'file') {
        const fileHandle = file.handle as FileSystemFileHandle;
        const fileData = await fileHandle.getFile();
        const originalUrl = URL.createObjectURL(fileData);
        
        setSelectedFile({
          ...file,
          original: originalUrl,
          originalSize: fileData.size,
          compressed: null
        });
        
        const { blob, width, height } = await compressImage(fileData, quality, format, outputSize);
        const compressedUrl = URL.createObjectURL(blob);
        
        setSelectedFile(prev => prev ? {
          ...prev,
          compressed: compressedUrl,
          compressedSize: blob.size,
          width,
          height
        } : null);
        
        setStatus(`Successfully loaded and compressed ${file.name}`);
      }
    } catch (err) {
      setStatus(`Error processing file: ${err instanceof Error ? err.message : 'Unknown error'}`);
      console.error('File processing error:', err);
    }
  };

  const handleDownload = async (type: 'original' | 'compressed') => {
    if (!selectedFile) return;
    
    try {
      const fileHandle = selectedFile.handle as FileSystemFileHandle;
      const fileData = await fileHandle.getFile();
      
      if (type === 'original') {
        // For original, use the file directly
        const a = document.createElement('a');
        a.href = URL.createObjectURL(fileData);
        a.download = selectedFile.name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      } else if (type === 'compressed' && selectedFile.compressed) {
        // For compressed, fetch the blob and create a download with the correct extension
        const response = await fetch(selectedFile.compressed);
        const blob = await response.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        
        // Modify filename to include compression info and correct extension
        const nameWithoutExt = selectedFile.name.substring(0, selectedFile.name.lastIndexOf('.'));
        const newExt = format.toLowerCase();
        a.download = `${nameWithoutExt}_compressed_${Math.round(quality * 100)}q.${newExt}`;
        
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      }
    } catch (error) {
      console.error('Error downloading file:', error);
      setStatus('Error downloading file');
    }
  };

  useEffect(() => {
    const loadStoredDirectory = async () => {
      try {
        setIsLoading(true);
        const storedHandle = await getStoredDirectoryHandle();
        if (storedHandle) {
          setDirectoryHandle(storedHandle);
          const filesInDir = await getFiles(storedHandle);
          setFiles(filesInDir);
          setStatus('Restored previously selected directory');
        }
      } catch (error) {
        console.error('Error loading stored directory:', error);
        setStatus('Failed to restore previous directory');
      } finally {
        setIsLoading(false);
      }
    };

    if ('showDirectoryPicker' in window) {
      loadStoredDirectory();
    } else {
      setStatus('File System Access API is not supported in this browser');
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selectedFile?.handle) {
      const recompress = async () => {
        try {
          const fileHandle = await (selectedFile.handle as FileSystemFileHandle).getFile();
          const { blob, width, height } = await compressImage(fileHandle, quality, format, outputSize);
          const compressedUrl = URL.createObjectURL(blob);
          
          setSelectedFile(prev => prev ? {
            ...prev,
            compressed: compressedUrl,
            compressedSize: blob.size,
            width,
            height
          } : null);
        } catch (error) {
          console.error('Error recompressing:', error);
        }
      };
      
      recompress();
    }
  }, [quality, format, outputSize, selectedFile?.handle]);

  return (
    <div className="min-h-screen bg-gray-50 py-8 px-4">
      <div className="max-w-7xl mx-auto">
        <div className="bg-white rounded-lg shadow-lg p-6">
          <h1 className="text-2xl font-bold mb-6 text-gray-800">Image Compressor & Viewer</h1>
          
          <div className="mb-6 flex gap-4">
            <button
              onClick={handleSelectDirectory}
              disabled={isLoading}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${
                isLoading
                  ? 'bg-gray-400 cursor-not-allowed'
                  : 'bg-blue-600 hover:bg-blue-700'
              } text-white`}
            >
              <FolderOpen size={20} />
              {isLoading ? 'Loading...' : directoryHandle ? 'Change Directory' : 'Select Directory'}
            </button>

            {selectedFile && (
              <div className="flex gap-2">
                <button
                  onClick={() => setViewMode(viewMode === 'preview' ? 'compare' : 'preview')}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg bg-purple-600 hover:bg-purple-700 text-white"
                >
                  <SplitHorizontal size={20} />
                  {viewMode === 'preview' ? 'Compare View' : 'Preview'}
                </button>
                <button
                  onClick={() => handleDownload('original')}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg bg-green-600 hover:bg-green-700 text-white"
                >
                  <Download size={20} />
                  Original
                </button>
                {selectedFile.compressed && (
                  <button
                    onClick={() => handleDownload('compressed')}
                    className="flex items-center gap-2 px-4 py-2 rounded-lg bg-green-600 hover:bg-green-700 text-white"
                  >
                    <Download size={20} />
                    Compressed
                  </button>
                )}
              </div>
            )}
          </div>

          {status && (
            <div className={`mb-4 p-3 rounded-lg ${
              status.toLowerCase().includes('error') || status.toLowerCase().includes('denied')
                ? 'bg-red-50 text-red-700'
                : status.toLowerCase().includes('success') || status.toLowerCase().includes('restored')
                ? 'bg-green-50 text-green-700'
                : 'bg-gray-100 text-gray-700'
            }`}>
              {status}
            </div>
          )}

          {selectedFile && (
            <div className="mb-6 space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Quality ({Math.round(quality * 100)}%)
                  </label>
                  <input
                    type="range"
                    min="0.1"
                    max="1"
                    step="0.1"
                    value={quality}
                    onChange={(e) => setQuality(parseFloat(e.target.value))}
                    className="w-full"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Format
                  </label>
                  <select
                    value={format}
                    onChange={(e) => setFormat(e.target.value)}
                    className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
                  >
                    <option value="webp">WebP</option>
                    <option value="jpeg">JPEG</option>
                    <option value="png">PNG</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Output Size ({outputSize}%)
                  </label>
                  <input
                    type="range"
                    min="10"
                    max="100"
                    step="5"
                    value={outputSize}
                    onChange={(e) => setOutputSize(parseInt(e.target.value))}
                    className="w-full"
                  />
                </div>
              </div>

              {selectedFile.compressedSize && (
                <div className="flex gap-4 text-sm text-gray-600">
                  <span>Original: {(selectedFile.originalSize / 1024).toFixed(1)} KB</span>
                  <span>Compressed: {(selectedFile.compressedSize / 1024).toFixed(1)} KB</span>
                  <span>Reduction: {((1 - selectedFile.compressedSize / selectedFile.originalSize) * 100).toFixed(1)}%</span>
                </div>
              )}
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="md:col-span-1">
              <div className="mb-4">
                <h2 className="text-lg font-semibold mb-2 text-gray-700">
                  Image Files
                </h2>
              </div>

              <div className="space-y-2 max-h-[calc(100vh-300px)] overflow-y-auto">
                {isLoading ? (
                  <p className="text-gray-500 italic">Loading files...</p>
                ) : files.length > 0 ? (
                  files.map((file, index) => (
                    <button
                      key={index}
                      onClick={() => handleFileSelect(file)}
                      className={`w-full flex items-center gap-3 p-3 rounded-lg hover:bg-blue-50 transition-colors text-left ${
                        selectedFile?.name === file.name ? 'bg-blue-50 ring-2 ring-blue-500' : 'bg-gray-50'
                      }`}
                    >
                      <Image className="text-blue-600 flex-shrink-0" size={20} />
                      <span className="text-gray-700 flex-1 truncate">{file.name}</span>
                    </button>
                  ))
                ) : (
                  <p className="text-gray-500 italic">
                    No image files found. Select a directory to view files.
                  </p>
                )}
              </div>
            </div>

            <div className="md:col-span-2">
              <div className="mb-4">
                <h2 className="text-lg font-semibold mb-2 text-gray-700">
                  {viewMode === 'preview' ? 'Preview' : 'Comparison'}
                </h2>
              </div>
              
              <div className="bg-gray-50 rounded-lg p-4 min-h-[500px] flex items-center justify-center">
                {selectedFile ? (
                  viewMode === 'preview' ? (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 w-full">
                      <div className="space-y-2">
                        <h3 className="text-center font-medium text-gray-700">Original</h3>
                        <img 
                          src={selectedFile.original} 
                          alt="Original" 
                          className="max-w-full h-auto rounded-lg"
                        />
                      </div>
                      <div className="space-y-2">
                        <h3 className="text-center font-medium text-gray-700">Compressed</h3>
                        {selectedFile.compressed ? (
                          <img 
                            src={selectedFile.compressed} 
                            alt="Compressed" 
                            className="max-w-full h-auto rounded-lg"
                          />
                        ) : (
                          <div className="flex items-center justify-center h-full">
                            <p className="text-gray-500 italic">Compressing...</p>
                          </div>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="w-full h-[500px]">
                      {selectedFile.compressed && (
                        <ReactCompareSlider
                          itemOne={<ReactCompareSliderImage src={selectedFile.original} alt="Original" />}
                          itemTwo={<ReactCompareSliderImage src={selectedFile.compressed} alt="Compressed" />}
                          className="h-full rounded-lg overflow-hidden"
                        />
                      )}
                    </div>
                  )
                ) : (
                  <div className="text-center">
                    <Image className="mx-auto text-gray-400 mb-4" size={48} />
                    <p className="text-gray-500 italic">
                      Select an image to view and compress
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;