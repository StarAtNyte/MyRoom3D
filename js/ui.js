import {
    setSelectedImageFile, detectedWallPlane, wallDecorParams, viewer,
    splatLoaded, floorPlaneMesh, floorPlaneVisible,
    setFloorPlaneVisible, setCurrentSplatPath, setSplatLoaded,
    wallGaussianPositions, wallClusters, wallClusterHelpers,
    setWallClusterHelpers, setWallClusters, wallDecor, rug,
    initialCameraState
} from './utils.js';
import { generateSplatFromImage, downloadGeneratedPLY, loadSplatFromFolder, loadSplatFromPlyFile } from './api.js';
import { detectFloor, createFloorPlaneVisualization } from './floorDetection.js';
import { detectWall, collectWallGaussians, clusterWallsByOrientation } from './wallDetection.js';
import { placeRugAuto, removeCurrentRug } from './rug.js';
import {
    createWallDecor, placeWallDecorOnWall, setupWallDecorGUI, removeCurrentWallDecor,
    startWallSelectionMode, handleWallClick, handleWallHover,
} from './wallDecor.js';
import * as THREE from 'three';

// Placeholder exports
export function populateRugGrid() {
    const grid = document.getElementById('rugGrid');
    grid.innerHTML = '';

    const rugs = [
        { name: 'Abanes', path: 'assets/rugs/Abanes.jpg' },
        { name: 'Abiponet', path: 'assets/rugs/Abiponet.jpg' },
        { name: 'Atlantede', path: 'assets/rugs/Atlantede.jpg' },
        { name: 'Cubinia', path: 'assets/rugs/Cubinia.png' },
        { name: 'Easther', path: 'assets/rugs/Easther.jpg' },
        { name: 'Tappeto Classico', path: 'assets/rugs/Tappeto Classico.jpg' },
        { name: 'Tappeto Classico Sea Green', path: 'assets/rugs/Tappeto Classico Sea Green.jpg' },
        { name: 'Telerense', path: 'assets/rugs/Telerense.jpg' }
    ];

    rugs.forEach(rug => {
        const item = document.createElement('div');
        item.className = 'rug-item';
        item.innerHTML = `
            <img src="${rug.path}" alt="${rug.name}">
            <div class="rug-name">${rug.name}</div>
        `;
        item.addEventListener('click', () => selectRug(rug.path));
        grid.appendChild(item);
    });
}

export function populateWallDecorGrid() {
    const grid = document.getElementById('wallDecorGrid');
    grid.innerHTML = '';

    const wallDecors = [
        { name: 'Wall Decor 1', path: 'assets/wallDecors/wallDecor1.jpg' },
        { name: 'Wall Decor 2', path: 'assets/wallDecors/wallDecor2.jpg' },
        { name: 'Wall Decor 3', path: 'assets/wallDecors/wallDecor3.png' },
        { name: 'Wall Decor 4', path: 'assets/wallDecors/wallDecor4.png' },
        { name: 'Wall Decor 5', path: 'assets/wallDecors/wallDecor5.png' }
    ];

    wallDecors.forEach(decor => {
        const item = document.createElement('div');
        item.className = 'wall-decor-item';
        item.innerHTML = `
            <img src="${decor.path}" alt="${decor.name}">
            <div class="decor-name">${decor.name}</div>
        `;
        item.addEventListener('click', () => selectWallDecor(decor.path));
        grid.appendChild(item);
    });
}

export async function selectRug(rugPath) {
    const status = document.getElementById('status');

    // Highlight selected item
    document.querySelectorAll('.rug-item').forEach(item => {
        item.classList.remove('selected');
    });
    if (event && event.target) {
        const clickedItem = event.target.closest('.rug-item');
        if (clickedItem) clickedItem.classList.add('selected');
    }

    status.textContent = 'Loading rug...';
    status.style.display = 'block';

    try {
        await placeRugAuto(rugPath);
        document.getElementById('rugSidebar').classList.remove('open');
        // Show controls after sidebar closes
        showAllControls();
    } catch (error) {
        status.textContent = `Error: ${error.message}`;
        console.error(error);
    }
}

export async function selectWallDecor(decorPath) {
    const status = document.getElementById('status');

    // Highlight selected item
    document.querySelectorAll('.wall-decor-item').forEach(item => {
        item.classList.remove('selected');
    });
    event.target.closest('.wall-decor-item').classList.add('selected');

    // Remove old wall decor
    removeCurrentWallDecor();

    // Show loading indicator
    const loader = document.getElementById('wallDetectionLoader');
    const backdrop = document.getElementById('wallDetectionBackdrop');
    const loaderText = loader.querySelector('.loader-text');
    const loaderSubtext = loader.querySelector('.loader-subtext');
    const loaderProgress = loader.querySelector('.loader-progress');

    loader.classList.add('active');
    backdrop.classList.add('active');

    try {
        // Detect wall if not already detected
        if (wallGaussianPositions.length === 0) {
            loaderText.textContent = 'Detecting Walls';
            loaderSubtext.textContent = 'Analyzing scene geometry...';
            loaderProgress.textContent = '';

            const wallDetected = await detectWall();
            if (!wallDetected) {
                loader.classList.remove('active');
                backdrop.classList.remove('active');
                status.textContent = 'Wall detection failed!';
                status.style.display = 'block';
                return;
            }
        }

        // Cluster walls if not already done
        if (wallClusters.length === 0) {
            loaderText.textContent = 'Clustering Walls';
            loaderSubtext.textContent = 'Grouping wall surfaces...';
            loaderProgress.textContent = `Processing ${wallGaussianPositions.length.toLocaleString()} points`;

            const cameraPos = viewer.camera.position.clone();
            const minWallWidth = 1.0;
            const clusters = clusterWallsByOrientation(wallGaussianPositions, cameraPos, minWallWidth);
            setWallClusters(clusters);

            if (clusters.length === 0) {
                loader.classList.remove('active');
                backdrop.classList.remove('active');
                status.textContent = 'No suitable walls found!';
                status.style.display = 'block';
                return;
            }

            loaderProgress.textContent = `Found ${clusters.length} wall${clusters.length > 1 ? 's' : ''}`;
            console.log(`Found ${clusters.length} suitable walls`);
        }

        // Create and place the wall decor
        loaderText.textContent = 'Preparing Decor';
        loaderSubtext.textContent = 'Loading texture and creating preview...';
        loaderProgress.textContent = '';

        await createWallDecor(decorPath);

        // Reset offsets for new placement
        wallDecorParams.offsetX = 0;
        wallDecorParams.offsetY = 0;
        wallDecorParams.offsetZ = 0.08;

        // Enter wall selection mode
        const selectionStarted = startWallSelectionMode();

        // Hide loader AFTER starting selection mode
        setTimeout(() => {
            loader.classList.remove('active');
            backdrop.classList.remove('active');
            console.log(' Loader hidden');
        }, 100);

        if (selectionStarted) {
            setupWallDecorGUI();
            document.getElementById('wallDecorSidebar').classList.remove('open');
            // Show controls after sidebar closes
            showAllControls();
        } else {
            loader.classList.remove('active');
            backdrop.classList.remove('active');
            status.textContent = 'Error: Could not start wall selection';
            status.style.display = 'block';
        }

    } catch (error) {
        loader.classList.remove('active');
        backdrop.classList.remove('active');
        status.textContent = `Error: ${error.message}`;
        status.style.display = 'block';
        console.error(error);
    }
}

// Helper function to stack GUI controls vertically
function stackGUIControls() {
    const guiElements = Array.from(document.querySelectorAll('.lil-gui.root'));

    let currentTop = 20; // Starting top position
    const gap = 12; // Gap between panels

    guiElements.forEach((gui, index) => {
        gui.style.top = currentTop + 'px';
        // Get the actual height of this GUI panel
        const height = gui.offsetHeight;
        currentTop += height + gap;
    });
}

// Set up MutationObserver to watch for GUI changes (collapse/expand)
let guiObserver = null;

function setupGUIObserver() {
    // Disconnect existing observer if any
    if (guiObserver) {
        guiObserver.disconnect();
    }

    guiObserver = new MutationObserver(() => {
        // Debounce the stacking to avoid too many calls
        clearTimeout(window._stackTimeout);
        window._stackTimeout = setTimeout(() => {
            stackGUIControls();
        }, 10);
    });

    // Observe all GUI elements for changes
    const observeGUIs = () => {
        const guiElements = document.querySelectorAll('.lil-gui.root');
        guiElements.forEach(gui => {
            guiObserver.observe(gui, {
                attributes: true,
                childList: true,
                subtree: true,
                attributeFilter: ['class', 'style']
            });
        });
    };

    observeGUIs();

    // Re-observe when new GUIs are added
    const bodyObserver = new MutationObserver(() => {
        observeGUIs();
        stackGUIControls();
    });

    bodyObserver.observe(document.body, {
        childList: true,
        subtree: true
    });
}

// Helper functions to manage control visibility when sidebars open/close
function hideAllControls() {
    // Push lil-gui controls to the left when sidebar opens
    const guiElements = document.querySelectorAll('.lil-gui.root');
    guiElements.forEach(gui => {
        gui.style.right = '300px';
    });

    // Hide wall decor arrow controls
    const arrowControls = document.getElementById('wallDecorArrowControls');
    if (arrowControls) {
        arrowControls.style.display = 'none';
    }
}

function showAllControls() {
    // Return lil-gui controls to original position
    const guiElements = document.querySelectorAll('.lil-gui.root');
    guiElements.forEach(gui => {
        gui.style.right = '20px';
    });

    // Show wall decor arrow controls (if they were visible before)
    const arrowControls = document.getElementById('wallDecorArrowControls');
    if (arrowControls && arrowControls.classList.contains('visible')) {
        arrowControls.style.display = '';
    }

    // Stack GUI controls after showing them - use a longer delay to ensure transition completes
    setTimeout(() => {
        stackGUIControls();
    }, 50);
}

export function initializeUI(cleanupSceneFunc) {
    console.log('Initializing UI...');

    // Set up GUI observer for collapse/expand detection
    setupGUIObserver();

    // Populate grids
    populateRugGrid();
    populateWallDecorGrid();

    // Setup canvas mouse handlers for wall selection
    const canvas = viewer.renderer.domElement;

    canvas.addEventListener('click', (event) => {
        // Try to handle wall selection first
        const handled = handleWallClick(event);
        // If not in wall selection mode, other handlers will take over
    });

    canvas.addEventListener('mousemove', (event) => {
        handleWallHover(event);
    });

    // Splat select dropdown
    document.getElementById('splatSelect').addEventListener('change', async (event) => {
        const selectedPath = event.target.value;
        const status = document.getElementById('status');

        status.style.display = 'block';
        status.textContent = 'Loading scene...';

        try {
            setCurrentSplatPath(selectedPath);
            await loadSplatFromFolder(selectedPath, cleanupSceneFunc);
        } catch (error) {
            console.error('Error loading splat:', error);
            status.textContent = `Error loading scene: ${error.message}`;
        }
    });

    // Generate splat event listeners
    document.getElementById('generateSplatInput').addEventListener('change', (event) => {
        const file = event.target.files[0];
        if (file) {
            setSelectedImageFile(file);
            document.getElementById('generateSplatBtn').disabled = false;
            console.log('Image selected:', file.name);
        } else {
            setSelectedImageFile(null);
            document.getElementById('generateSplatBtn').disabled = true;
        }
    });

    document.getElementById('generateSplatBtn').addEventListener('click', async () => {
        const fileInput = document.getElementById('generateSplatInput');
        const selectedFile = fileInput.files[0];
        if (selectedFile) {
            await generateSplatFromImage(selectedFile, cleanupSceneFunc);
        }
    });

    document.getElementById('uploadPlyInput').addEventListener('change', async (event) => {
        const file = event.target.files[0];
        if (file) {
            await loadSplatFromPlyFile(file, cleanupSceneFunc);
        }
    });

    document.getElementById('debugDownloadPlyBtn').addEventListener('click', () => {
        downloadGeneratedPLY();
    });

    // Toggle floor plane button
    document.getElementById('toggleFloorBtn').addEventListener('click', async () => {
        const btn = document.getElementById('toggleFloorBtn');

        if (!floorPlaneMesh) {
            const detected = await detectFloor();
            if (detected && floorPlaneMesh) {
                floorPlaneMesh.visible = true;
                setFloorPlaneVisible(true);
                btn.textContent = 'Hide Floor Plane';
            }
        } else {
            const newVisibility = !floorPlaneVisible;
            floorPlaneMesh.visible = newVisibility;
            setFloorPlaneVisible(newVisibility);
            btn.textContent = newVisibility ? 'Hide Floor Plane' : 'Show Floor Plane';
        }
    });

    // Toggle wall button
    document.getElementById('toggleWallBtn').addEventListener('click', async () => {
        await detectWall();
    });

    // Show wall clusters button
    document.getElementById('showWallClustersBtn').addEventListener('click', async () => {
        const btn = document.getElementById('showWallClustersBtn');
        const status = document.getElementById('status');

        // Toggle visibility if clusters already exist
        if (wallClusterHelpers.length > 0) {
            const areVisible = wallClusterHelpers[0].visible;
            wallClusterHelpers.forEach(helper => helper.visible = !areVisible);
            btn.textContent = areVisible ? 'Show Wall Clusters' : 'Hide Wall Clusters';
            return;
        }

        // Otherwise, create clusters
        status.style.display = 'block';
        status.textContent = 'Clustering walls...';

        if (wallGaussianPositions.length === 0) {
            const collected = collectWallGaussians();
            if (!collected) {
                status.textContent = 'No wall gaussians available!';
                return;
            }
        }

        const cameraPos = viewer.camera.position.clone();
        const minWallWidth = 1.0;
        const clusters = clusterWallsByOrientation(wallGaussianPositions, cameraPos, minWallWidth);

        if (clusters.length === 0) {
            status.textContent = 'No wall clusters found!';
            return;
        }

        // Visualize clusters
        const helpers = [];
        const colors = [0xff0000, 0x00ff00, 0x0000ff, 0xffff00, 0xff00ff, 0x00ffff];

        clusters.forEach((cluster, i) => {
            const color = colors[i % colors.length];
            const geometry = new THREE.BufferGeometry();
            const positions = new Float32Array(cluster.gaussians.length * 3);

            cluster.gaussians.forEach((pos, j) => {
                positions[j * 3] = pos.x;
                positions[j * 3 + 1] = pos.y;
                positions[j * 3 + 2] = pos.z;
            });

            geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
            const material = new THREE.PointsMaterial({ color, size: 0.05 });
            const points = new THREE.Points(geometry, material);

            viewer.threeScene.add(points);
            helpers.push(points);
        });

        setWallClusterHelpers(helpers);
        btn.textContent = 'Hide Wall Clusters';
        status.innerHTML = `<strong>${clusters.length} wall clusters visualized!</strong>`;
    });

    // Open/close sidebars
    document.getElementById('openRugBtn').addEventListener('click', () => {
        // Close wall decor sidebar if open
        document.getElementById('wallDecorSidebar').classList.remove('open');
        // Hide controls to prevent overlap
        hideAllControls();
        // Open rug sidebar
        document.getElementById('rugSidebar').classList.add('open');
    });

    document.getElementById('closeRugBtn').addEventListener('click', () => {
        document.getElementById('rugSidebar').classList.remove('open');
        // Show controls again
        showAllControls();
    });

    document.getElementById('openWallDecorBtn').addEventListener('click', () => {
        // Close rug sidebar if open
        document.getElementById('rugSidebar').classList.remove('open');
        // Hide controls to prevent overlap
        hideAllControls();
        // Open wall decor sidebar
        document.getElementById('wallDecorSidebar').classList.add('open');
    });

    document.getElementById('closeWallDecorBtn').addEventListener('click', () => {
        document.getElementById('wallDecorSidebar').classList.remove('open');
        // Show controls again
        showAllControls();
    });

    // Custom uploads
    document.getElementById('customRugInput').addEventListener('change', async (event) => {
        const file = event.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = async (e) => {
                await selectRug(e.target.result);
            };
            reader.readAsDataURL(file);
        }
    });

    document.getElementById('customWallDecorInput').addEventListener('change', async (event) => {
        const file = event.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = async (e) => {
                await selectWallDecor(e.target.result);
            };
            reader.readAsDataURL(file);
        }
    });

    // Camera lock/unlock
    let cameraLocked = true;

    // Store the fixed camera target position (prevents click-to-focus)
    const fixedTarget = new THREE.Vector3(
        initialCameraState.lookAt.x,
        initialCameraState.lookAt.y,
        initialCameraState.lookAt.z
    );

    if (viewer.controls) {
        viewer.controls.enabled = false;
        viewer.controls.enableRotate = false;
        viewer.controls.enableZoom = false;
        viewer.controls.enablePan = false;
        // Disable keyboard controls (arrow keys)
        viewer.controls.enableKeys = false;
        viewer.controls.listenToKeyEvents = false;

        // Set initial target
        viewer.controls.target.copy(fixedTarget);
        viewer.controls.update();
    }

    // Prevent click-to-focus by constantly resetting target to fixed position
    // This runs on every frame and immediately corrects any target changes
    function enforceFixedTarget() {
        if (viewer && viewer.controls && !cameraLocked) {
            // Always enforce fixed target to prevent click-to-focus
            if (!viewer.controls.target.equals(fixedTarget)) {
                viewer.controls.target.copy(fixedTarget);
                viewer.controls.update();
            }
        }
        requestAnimationFrame(enforceFixedTarget);
    }
    enforceFixedTarget();

    document.getElementById('cameraLockBtn').addEventListener('click', () => {
        const btn = document.getElementById('cameraLockBtn');
        cameraLocked = !cameraLocked;

        if (viewer.controls) {
            viewer.controls.enabled = !cameraLocked;
            viewer.controls.enableRotate = !cameraLocked;
            viewer.controls.enableZoom = !cameraLocked;
            viewer.controls.enablePan = !cameraLocked;
            // Keep keyboard controls disabled even when camera is unlocked
            viewer.controls.enableKeys = false;
            viewer.controls.listenToKeyEvents = false;
        }

        btn.textContent = cameraLocked ? 'Unlock Camera' : 'Lock Camera';
        console.log(`Camera ${cameraLocked ? 'locked' : 'unlocked'} (keyboard controls remain disabled)`);
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (event) => {
        if (event.key === 'h' || event.key === 'H') {
            const controls = document.getElementById('controls');
            const instructions = document.getElementById('instructions');
            const rugSidebar = document.getElementById('rugSidebar');
            const wallDecorSidebar = document.getElementById('wallDecorSidebar');
            const isVisible = controls.style.display !== 'none';

            // Toggle controls and instructions
            controls.style.display = isVisible ? 'none' : 'flex';
            instructions.style.display = isVisible ? 'none' : 'block';

            // Toggle lil-gui controls
            const guiElements = document.querySelectorAll('.lil-gui.root');
            guiElements.forEach(gui => {
                gui.style.display = isVisible ? 'none' : '';
            });

            // Toggle sidebars
            if (isVisible) {
                // Hide sidebars
                if (rugSidebar) rugSidebar.classList.remove('open');
                if (wallDecorSidebar) wallDecorSidebar.classList.remove('open');
            }
        }

        if (event.ctrlKey && event.shiftKey && event.key === 'D') {
            event.preventDefault();
            const debugPanel = document.getElementById('debugPanel');
            const isVisible = debugPanel.style.display !== 'none';
            debugPanel.style.display = isVisible ? 'none' : 'block';
            console.log(`Debug panel ${isVisible ? 'hidden' : 'shown'}`);
        }

        // Delete or Backspace to remove placed items
        if (event.key === 'Delete' || event.key === 'Backspace') {
            // Don't trigger if user is typing in an input field
            if (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA') {
                return;
            }

            event.preventDefault();

            // Try to remove wall decor first (if it exists), otherwise remove rug
            if (wallDecor) {
                removeCurrentWallDecor();
                console.log('Wall decor removed via keyboard shortcut');
            } else if (rug) {
                removeCurrentRug();
                console.log('Rug removed via keyboard shortcut');
            } else {
                console.log('No items to remove');
            }
        }
    });


    console.log('UI fully initialized');
}