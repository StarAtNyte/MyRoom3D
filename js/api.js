import * as THREE from 'three';
import {
    viewer,
    generatedSplatData,
    floorMaskData,
    wallMaskData,
    setGeneratedSplatData,
    setFloorMaskData,
    setWallMaskData,
    setFloorOrientation,
    setSplatLoaded,
    setIsLoadingScene
} from './utils.js';
import JSZip from 'jszip';

/**
 * Decompress gzipped data from base64 string
 * @param {string} base64String - Base64-encoded gzipped data
 * @returns {Promise<string>} - Decompressed base64 data
 */
async function decompressGzipBase64(base64String) {
    const startTime = performance.now();

    // Decode base64 to binary
    const binaryString = atob(base64String);
    const compressedBytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
        compressedBytes[i] = binaryString.charCodeAt(i);
    }

    // Decompress using browser's DecompressionStream API
    const blob = new Blob([compressedBytes]);
    const stream = blob.stream().pipeThrough(new DecompressionStream('gzip'));
    const decompressedBlob = await new Response(stream).blob();
    const decompressedBytes = new Uint8Array(await decompressedBlob.arrayBuffer());

    // Convert back to base64
    let decompressedBinary = '';
    const chunkSize = 0x8000; // Process in chunks to avoid stack overflow
    for (let i = 0; i < decompressedBytes.length; i += chunkSize) {
        const chunk = decompressedBytes.subarray(i, i + chunkSize);
        decompressedBinary += String.fromCharCode.apply(null, chunk);
    }
    const decompressedBase64 = btoa(decompressedBinary);

    const elapsed = performance.now() - startTime;
    console.log(`Decompressed PLY: ${(compressedBytes.length / 1024 / 1024).toFixed(2)}MB → ${(decompressedBytes.length / 1024 / 1024).toFixed(2)}MB in ${elapsed.toFixed(0)}ms`);

    return decompressedBase64;
}

/**
 * Decode bitpacked boolean mask from base64 string
 * @param {string} base64String - Base64-encoded packed bits
 * @param {number} length - Original length of boolean array
 * @returns {boolean[]} - Unpacked boolean array
 */
function decodeBitpackedMask(base64String, length) {
    // Decode base64 to binary
    const binaryString = atob(base64String);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }

    // Unpack bits to boolean array
    const boolArray = [];
    for (let i = 0; i < length; i++) {
        const byteIndex = Math.floor(i / 8);
        const bitIndex = 7 - (i % 8); // MSB first (numpy packbits convention)
        const bit = (bytes[byteIndex] >> bitIndex) & 1;
        boolArray.push(bit === 1);
    }

    console.log(`Decoded bitpacked mask: ${bytes.length} bytes → ${boolArray.length} booleans`);
    return boolArray;
}

/**
 * Call the Sharp API to generate splat from image
 */
export async function generateSplatFromImage(imageFile, cleanupSceneFunc) {
    const status = document.getElementById('status');
    const generateBtn = document.getElementById('generateSplatBtn');

    status.style.display = 'block';
    status.classList.add('loading');
    status.textContent = 'Uploading image to API...';

    // Disable button and show loading state
    generateBtn.disabled = true;
    generateBtn.textContent = 'Processing...';

    // Get original image dimensions
    const imageAspectRatio = await new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            const aspect = img.width / img.height;
            console.log(`Original image: ${img.width}x${img.height} (aspect: ${aspect.toFixed(3)})`);
            resolve(aspect);
        };
        img.src = URL.createObjectURL(imageFile);
    });

    try {
        const formData = new FormData();
        formData.append('file', imageFile);

        const apiUrl = 'https://nitizkhanal00--sharp-api-myroom-v2-fastapi-app.modal.run/predict';

        status.innerHTML = '<strong>Processing your room...</strong><br>This may take 1-2 minutes. Please wait.';

        const response = await fetch(apiUrl, {
            method: 'POST',
            body: formData
        });

        if (!response.ok) {
            throw new Error(`API error: ${response.statusText}`);
        }

        // Stream and parse JSON incrementally to avoid blocking
        status.innerHTML = '<strong>Processing API response...</strong><br>Receiving data...';

        const reader = response.body.getReader();
        const chunks = [];
        let receivedLength = 0;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            chunks.push(value);
            receivedLength += value.length;

            // Update progress
            const mb = (receivedLength / 1024 / 1024).toFixed(2);
            status.innerHTML = `<strong>Processing API response...</strong><br>Received ${mb} MB...`;

            // Yield to UI
            await new Promise(resolve => setTimeout(resolve, 0));
        }

        // Combine chunks
        status.textContent = 'Parsing response data...';
        const chunksAll = new Uint8Array(receivedLength);
        let position = 0;
        for (let chunk of chunks) {
            chunksAll.set(chunk, position);
            position += chunk.length;
        }

        // Decode to string and parse JSON
        const text = new TextDecoder("utf-8").decode(chunksAll);
        const result = JSON.parse(text);

        // Decompress PLY if it's gzipped (new format)
        status.textContent = result.ply_compressed ? 'Decompressing PLY data...' : 'Processing PLY data...';
        const plyData = result.ply_compressed
            ? await decompressGzipBase64(result.ply)
            : result.ply; // Fallback for old format

        // Decode compressed boolean masks (bitpacked format)
        const floorMask3D = result.floor_mask_3d_length
            ? decodeBitpackedMask(result.floor_mask_3d, result.floor_mask_3d_length)
            : result.floor_mask_3d; // Fallback for old format

        const wallMask3D = result.wall_mask_3d_length
            ? decodeBitpackedMask(result.wall_mask_3d, result.wall_mask_3d_length)
            : result.wall_mask_3d; // Fallback for old format

        // Store base64 data (decompressed PLY) and aspect ratio
        setGeneratedSplatData(plyData);
        setFloorMaskData(floorMask3D);
        setWallMaskData(wallMask3D);

        // Store aspect ratio in window for viewport adjustment
        window.splatAspectRatio = imageAspectRatio;
        console.log('Stored aspect ratio:', imageAspectRatio.toFixed(3));

        console.log('Response size:', receivedLength, 'bytes (', (receivedLength / 1024 / 1024).toFixed(2), 'MB)');

        // Log floor mask info
        if (result.floor_mask_3d) {
            console.log('Floor mask 3D received:', result.floor_mask_3d.length, 'values');
            console.log('Floor coverage 3D:', (result.floor_coverage_3d * 100).toFixed(1) + '%');
        }
        // Log wall mask info
        if (result.wall_mask_3d) {
            console.log('Wall mask 3D received:', result.wall_mask_3d.length, 'values');
            console.log('Wall coverage 3D:', (result.wall_coverage_3d * 100).toFixed(1) + '%');
        }
        if (result.gaussian_grid_info) {
            console.log('Gaussian grid info:', result.gaussian_grid_info);
        }

        // Always use front view / horizontal floor orientation for generated splats
        const viewType = 'front';
        setFloorOrientation('horizontal');

        console.log('View type:', viewType, '→ Floor orientation: horizontal');
        status.innerHTML = `<strong>Loading splat...</strong>`;

        // Trigger viewport update with new aspect ratio
        if (window.updateSplatViewport) {
            window.updateSplatViewport();
        }

        // Load the generated splat
        loadGeneratedSplat(cleanupSceneFunc);

    } catch (error) {
        console.error('Error generating splat:', error);
        status.classList.remove('loading');
        status.innerHTML = `<strong>Error:</strong> ${error.message}`;

        // Re-enable button on error
        generateBtn.disabled = false;
        generateBtn.textContent = 'Generate Splat';
    }
}

/**
 * Load the generated splat from API response
 */
export async function loadGeneratedSplat(cleanupSceneFunc) {
    if (!generatedSplatData) {
        console.error('No generated splat data available');
        return;
    }

    const status = document.getElementById('status');
    const generateBtn = document.getElementById('generateSplatBtn');

    try {
        status.textContent = 'Preparing splat data...';

        // Use data URL approach
        const dataUrl = `data:application/octet-stream;base64,${generatedSplatData}#generated.ply`;

        console.log('Created data URL for PLY data, size:', generatedSplatData.length, 'chars');

        status.textContent = 'Cleaning up old scene...';

        // Clean up old scene but keep mask data (already set from API response)
        cleanupSceneFunc(false);

        // Remove old splat
        if (viewer.splatMesh) {
            await viewer.removeSplatScene(0);
        }

        setSplatLoaded(false);

        status.textContent = 'Loading new splat scene...';

        console.log('Loading splat from data URL');

        const loadPromise = viewer.addSplatScene(dataUrl, {
            progressiveLoad: true,
            format: 0 // SceneFormat.Ply - required for data URLs without file extension
        });

        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Loading timeout after 30s')), 30000)
        );

        await Promise.race([loadPromise, timeoutPromise]);

        viewer.start();
        setSplatLoaded(true);

        // Position camera to view splat like an image (matching splat.html)
        const cameraPosition = new THREE.Vector3(-0.22, -0.08684, 0.75);
        const lookAtPoint = new THREE.Vector3(-0.22, -0.08684, 4.05811);
        viewer.camera.position.copy(cameraPosition);
        viewer.camera.lookAt(lookAtPoint);
        if (viewer.controls) {
            viewer.controls.target.copy(lookAtPoint);
            viewer.controls.update();
        }

        // Enable floor detection button with appropriate text
        const toggleFloorBtn = document.getElementById('toggleFloorBtn');
        toggleFloorBtn.disabled = false;
        toggleFloorBtn.textContent = (floorMaskData && Array.isArray(floorMaskData)) ? 'Show Floor Plane' : 'Show Floor Detection';

        // Enable wall detection button with appropriate text
        const toggleWallBtn = document.getElementById('toggleWallBtn');
        toggleWallBtn.disabled = false;
        toggleWallBtn.textContent = (wallMaskData && Array.isArray(wallMaskData)) ? 'Show Wall Gaussians' : 'Show Wall Detection';

        // Enable wall clusters button
        const showWallClustersBtn = document.getElementById('showWallClustersBtn');
        showWallClustersBtn.disabled = false;
        showWallClustersBtn.textContent = 'Show Wall Clusters';

        // Camera controls remain in their current state (locked/unlocked via UI button)

        status.classList.remove('loading');
        status.innerHTML = '<strong>Splat loaded successfully!</strong><br>Click "Place Rug" to select and place a rug on the floor.';

        // Re-enable button
        generateBtn.disabled = false;
        generateBtn.textContent = 'Generate Splat';

        // Enable download buttons
        if (document.getElementById('debugDownloadPlyBtn')) {
            document.getElementById('debugDownloadPlyBtn').disabled = false;
        }

    } catch (error) {
        console.error('Error loading generated splat:', error);
        status.classList.remove('loading');
        status.innerHTML = `<strong>Error loading splat:</strong> ${error.message}`;

        // Re-enable button on error
        generateBtn.disabled = false;
        generateBtn.textContent = 'Generate Splat';
    }
}

/**
 * Download the generated splat as a ZIP file with PLY and mask data
 */
export async function downloadGeneratedPLY() {
    if (!generatedSplatData) {
        alert('No PLY data available. Please generate a splat first.');
        return;
    }

    try {
        console.log('Creating ZIP package with PLY and mask data...');

        const zip = new JSZip();

        // Add the PLY file
        const binaryString = atob(generatedSplatData);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        zip.file('room.ply', bytes);

        // Add metadata JSON with floor and wall masks (use compressed format if available)
        const metadata = {
            version: '2.1', // Bumped version for aspect ratio support
            type: 'sharp-room-splat',
            created: new Date().toISOString(),
            aspectRatio: window.splatAspectRatio || 1920 / 1080, // Store aspect ratio
            floorMask: floorMaskData || null,
            wallMask: wallMaskData || null,
            // Add length info for compressed format compatibility
            floorMaskLength: floorMaskData ? floorMaskData.length : 0,
            wallMaskLength: wallMaskData ? wallMaskData.length : 0
        };

        zip.file('metadata.json', JSON.stringify(metadata, null, 2));

        // Generate ZIP blob
        const blob = await zip.generateAsync({ type: 'blob' });

        // Download ZIP file
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'generated_room.zip';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        console.log('ZIP package downloaded: generated_room.zip');
        console.log('  - room.ply:', (bytes.length / 1024).toFixed(2), 'KB');
        console.log('  - metadata.json with floor mask:', floorMaskData ? floorMaskData.length : 0, 'values');
        console.log('  - metadata.json with wall mask:', wallMaskData ? wallMaskData.length : 0, 'values');
    } catch (error) {
        console.error('Error creating ZIP package:', error);
        alert('Error creating download package: ' + error.message);
    }
}

/**
 * Load a splat directly from a user-uploaded PLY file
 */
export async function loadSplatFromPlyFile(plyFile, cleanupSceneFunc) {
    const status = document.getElementById('status');

    setIsLoadingScene(true);

    const splatSelect = document.getElementById('splatSelect');
    if (splatSelect) {
        splatSelect.disabled = true;
    }

    try {
        status.style.display = 'block';
        status.textContent = 'Loading PLY file...';

        console.log('=== LOADING SPLAT FROM PLY FILE ===');
        console.log('File:', plyFile.name, 'Size:', (plyFile.size / 1024).toFixed(2), 'KB');

        // Create a blob URL for the PLY file
        const plyUrl = URL.createObjectURL(plyFile);

        // Use default 16:9 aspect ratio (no metadata available)
        window.splatAspectRatio = 1920 / 1080;

        if (window.updateSplatViewport) {
            window.updateSplatViewport();
        }

        // Clean up old scene
        cleanupSceneFunc(true);

        // No mask data available for raw PLY uploads
        setFloorMaskData(null);
        setWallMaskData(null);
        setFloorOrientation('horizontal');

        // Remove old splat
        if (viewer.splatMesh) {
            await viewer.removeSplatScene(0);
        }

        setSplatLoaded(false);

        status.textContent = 'Loading splat scene...';

        await viewer.addSplatScene(plyUrl, {
            progressiveLoad: true,
            format: 0 // SceneFormat.Ply - required for blob URLs without file extension
        });

        viewer.start();
        setSplatLoaded(true);

        // Clean up blob URL
        URL.revokeObjectURL(plyUrl);

        // Position camera
        const cameraPosition = new THREE.Vector3(-0.22, -0.08684, 0.75);
        const lookAtPoint = new THREE.Vector3(-0.22, -0.08684, 4.05811);
        viewer.camera.position.copy(cameraPosition);
        viewer.camera.lookAt(lookAtPoint);
        if (viewer.controls) {
            viewer.controls.target.copy(lookAtPoint);
            viewer.controls.update();
        }

        // Enable detection buttons
        const toggleFloorBtn = document.getElementById('toggleFloorBtn');
        toggleFloorBtn.disabled = false;
        toggleFloorBtn.textContent = 'Show Floor Detection';

        const toggleWallBtn = document.getElementById('toggleWallBtn');
        toggleWallBtn.disabled = false;
        toggleWallBtn.textContent = 'Show Wall Detection';

        const showWallClustersBtn = document.getElementById('showWallClustersBtn');
        showWallClustersBtn.disabled = false;
        showWallClustersBtn.textContent = 'Show Wall Clusters';

        status.textContent = 'PLY loaded! Click "Place Rug" to select and place a rug.';
        console.log('Splat loaded from PLY file successfully!');

    } catch (error) {
        console.error('Error loading PLY file:', error);
        status.textContent = `Error loading PLY: ${error.message}`;
        throw error;
    } finally {
        setIsLoadingScene(false);
        if (splatSelect) {
            splatSelect.disabled = false;
        }
    }
}

/**
 * Load a splat from a folder (containing room.ply + metadata.json)
 */
export async function loadSplatFromFolder(folderPath, cleanupSceneFunc) {
    const status = document.getElementById('status');

    // Set loading state to prevent scene changes
    setIsLoadingScene(true);

    // Disable scene selector dropdown
    const splatSelect = document.getElementById('splatSelect');
    if (splatSelect) {
        splatSelect.disabled = true;
    }

    try {
        status.style.display = 'block';
        status.textContent = 'Loading room...';

        console.log('=== LOADING SPLAT FROM FOLDER ===');
        console.log('Folder path:', folderPath);

        // Fetch metadata.json
        const metadataUrl = `${folderPath}/metadata.json`;
        status.textContent = 'Loading metadata...';

        const metadataResponse = await fetch(metadataUrl);
        if (!metadataResponse.ok) {
            throw new Error(`Could not load metadata.json from ${metadataUrl}`);
        }

        const metadata = await metadataResponse.json();
        console.log('Metadata loaded:', metadata);

        // Set aspect ratio from metadata (default to 16:9 for local scenes)
        window.splatAspectRatio = metadata.aspectRatio || (1920 / 1080);
        console.log('Aspect ratio:', window.splatAspectRatio.toFixed(3));

        // Trigger viewport update with new aspect ratio
        if (window.updateSplatViewport) {
            window.updateSplatViewport();
        }

        // Load the PLY file
        const plyUrl = `${folderPath}/room.ply`;
        status.textContent = 'Loading splat scene...';

        // Clean up old scene FIRST - clear everything including old mask data
        cleanupSceneFunc(true);

        // Decode masks (handle both compressed and legacy formats)
        // Check if mask is already an array (legacy) or a base64 string (compressed)
        const floorMask = metadata.floorMaskLength && typeof metadata.floorMask === 'string'
            ? decodeBitpackedMask(metadata.floorMask, metadata.floorMaskLength)
            : metadata.floorMask; // Legacy format (uncompressed array)

        const wallMask = metadata.wallMaskLength && typeof metadata.wallMask === 'string'
            ? decodeBitpackedMask(metadata.wallMask, metadata.wallMaskLength)
            : metadata.wallMask; // Legacy format (uncompressed array)

        // Then set the NEW scene's mask data
        setFloorMaskData(floorMask || null);
        setWallMaskData(wallMask || null);
        setFloorOrientation('horizontal');

        console.log('Floor mask:', floorMask ? floorMask.length : 0, 'values');
        console.log('Wall mask:', wallMask ? wallMask.length : 0, 'values');

        // Remove old splat
        if (viewer.splatMesh) {
            await viewer.removeSplatScene(0);
        }

        setSplatLoaded(false);

        console.log('Loading PLY from:', plyUrl);

        await viewer.addSplatScene(plyUrl, {
            progressiveLoad: true
        });

        viewer.start();
        setSplatLoaded(true);

        // Position camera to view splat like an image (matching splat.html)
        const cameraPosition = new THREE.Vector3(-0.22, -0.08684, 0.75);
        const lookAtPoint = new THREE.Vector3(-0.22, -0.08684, 4.05811);
        viewer.camera.position.copy(cameraPosition);
        viewer.camera.lookAt(lookAtPoint);
        if (viewer.controls) {
            viewer.controls.target.copy(lookAtPoint);
            viewer.controls.update();
        }

        // Enable floor detection button
        const toggleFloorBtn = document.getElementById('toggleFloorBtn');
        toggleFloorBtn.disabled = false;
        toggleFloorBtn.textContent = 'Show Floor Detection';

        // Enable wall detection button
        const toggleWallBtn = document.getElementById('toggleWallBtn');
        toggleWallBtn.disabled = false;
        toggleWallBtn.textContent = 'Show Wall Detection';

        // Enable wall clusters button
        const showWallClustersBtn = document.getElementById('showWallClustersBtn');
        showWallClustersBtn.disabled = false;
        showWallClustersBtn.textContent = 'Show Wall Clusters';

        // Camera controls remain in their current state (locked/unlocked via UI button)

        status.textContent = 'Room loaded! Click "Place Rug" to select and place a rug.';
        console.log('Splat loaded from folder successfully!');

    } catch (error) {
        console.error('Error loading from folder:', error);
        status.textContent = `Error loading room: ${error.message}`;
        throw error;
    } finally {
        // Always re-enable scene selector and clear loading state
        setIsLoadingScene(false);
        const splatSelect = document.getElementById('splatSelect');
        if (splatSelect) {
            splatSelect.disabled = false;
        }
    }
}

/**
 * Load a splat from ZIP file (containing PLY + metadata with masks)
 */
export async function loadSplatFromZip(zipFile, cleanupSceneFunc) {
    const status = document.getElementById('status');

    try {
        status.style.display = 'block';
        status.textContent = 'Loading ZIP file...';

        console.log('=== LOADING SPLAT FROM ZIP ===');

        const zip = new JSZip();
        const zipContents = await zip.loadAsync(zipFile);

        // Extract the PLY file
        const plyFile = zipContents.file('room.ply');
        if (!plyFile) {
            throw new Error('ZIP file does not contain room.ply');
        }

        status.textContent = 'Extracting PLY data...';
        const plyBlob = await plyFile.async('blob');
        const plyArrayBuffer = await plyBlob.arrayBuffer();
        const plyBytes = new Uint8Array(plyArrayBuffer);

        // Convert to base64 for storage
        let base64String = '';
        const chunkSize = 0x8000;
        for (let i = 0; i < plyBytes.length; i += chunkSize) {
            const chunk = plyBytes.subarray(i, i + chunkSize);
            base64String += String.fromCharCode.apply(null, chunk);
        }
        const plyBase64 = btoa(base64String);

        console.log('PLY extracted:', (plyBytes.length / 1024).toFixed(2), 'KB');

        // Extract metadata (floor and wall masks)
        const metadataFile = zipContents.file('metadata.json');
        let floorMask = null;
        let wallMask = null;

        if (metadataFile) {
            status.textContent = 'Loading floor and wall masks...';
            const metadataText = await metadataFile.async('text');
            const metadata = JSON.parse(metadataText);

            // Decode masks (handle both compressed and legacy formats)
            // Check if mask is already an array (legacy) or a base64 string (compressed)
            floorMask = metadata.floorMaskLength && typeof metadata.floorMask === 'string'
                ? decodeBitpackedMask(metadata.floorMask, metadata.floorMaskLength)
                : metadata.floorMask || null; // Legacy format

            wallMask = metadata.wallMaskLength && typeof metadata.wallMask === 'string'
                ? decodeBitpackedMask(metadata.wallMask, metadata.wallMaskLength)
                : metadata.wallMask || null; // Legacy format

            // Set aspect ratio from metadata (default to 16:9)
            window.splatAspectRatio = metadata.aspectRatio || (1920 / 1080);

            console.log('Metadata loaded:');
            console.log('  - Aspect ratio:', window.splatAspectRatio.toFixed(3));
            console.log('  - Floor mask:', floorMask ? floorMask.length : 0, 'values');
            console.log('  - Wall mask:', wallMask ? wallMask.length : 0, 'values');
        } else {
            console.warn('No metadata.json found in ZIP - using default 16:9 aspect ratio');
            window.splatAspectRatio = 1920 / 1080;
        }

        // Store the data
        setGeneratedSplatData(plyBase64);
        setFloorMaskData(floorMask);
        setWallMaskData(wallMask);
        setFloorOrientation('horizontal');

        // Trigger viewport update with new aspect ratio
        if (window.updateSplatViewport) {
            window.updateSplatViewport();
        }

        // Load the splat
        status.textContent = 'Loading splat scene...';
        await loadGeneratedSplat(cleanupSceneFunc);

        console.log('✅ Splat loaded from ZIP successfully!');

    } catch (error) {
        console.error('Error loading ZIP file:', error);
        status.textContent = `Error loading ZIP: ${error.message}`;
        throw error;
    }
}
