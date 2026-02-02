import Phaser from 'phaser';
import { useGameStore } from '@/stores/game';
import { BUILDING_ZONES } from '../data/building-zones';

const MAP_SCALE = 2;
const MAP_WIDTH = 780 * MAP_SCALE;  // 1560
const MAP_HEIGHT = 468 * MAP_SCALE; // 936
const PET_SPEED = 200;

interface Controls {
  up: Phaser.Input.Keyboard.Key;
  down: Phaser.Input.Keyboard.Key;
  left: Phaser.Input.Keyboard.Key;
  right: Phaser.Input.Keyboard.Key;
  enter: Phaser.Input.Keyboard.Key;
  escape: Phaser.Input.Keyboard.Key;
}

export class TownScene extends Phaser.Scene {
  private avatar!: Phaser.GameObjects.Rectangle & { body: Phaser.Physics.Arcade.Body };
  private controls!: Controls;
  private zones: Phaser.GameObjects.Zone[] = [];
  private currentOverlapZone: string | null = null;

  constructor() {
    super({ key: 'Town' });
  }

  create(): void {
    const store = useGameStore.getState();

    // Add map background centered
    const map = this.add.image(MAP_WIDTH / 2, MAP_HEIGHT / 2, 'map');
    map.setDisplaySize(MAP_WIDTH, MAP_HEIGHT);

    // Set world bounds
    this.physics.world.setBounds(0, 0, MAP_WIDTH, MAP_HEIGHT);

    // Create avatar sprite as colored rectangle
    const { x, y } = store.avatarPosition;
    const rect = this.add.rectangle(x, y, 32, 32, 0xff6600);
    this.physics.add.existing(rect);
    this.avatar = rect as typeof this.avatar;
    this.avatar.body.setCollideWorldBounds(true);

    // Camera setup
    this.cameras.main.startFollow(this.avatar, true, 0.1, 0.1);
    this.cameras.main.setBounds(0, 0, MAP_WIDTH, MAP_HEIGHT);

    // Input: arrow keys + WASD
    const cursors = this.input.keyboard!.createCursorKeys();
    const wasd = this.input.keyboard!.addKeys({
      w: Phaser.Input.Keyboard.KeyCodes.W,
      a: Phaser.Input.Keyboard.KeyCodes.A,
      s: Phaser.Input.Keyboard.KeyCodes.S,
      d: Phaser.Input.Keyboard.KeyCodes.D,
    }) as Record<string, Phaser.Input.Keyboard.Key>;

    this.controls = {
      up: this.mergeKeys(cursors.up!, wasd.w),
      down: this.mergeKeys(cursors.down!, wasd.s),
      left: this.mergeKeys(cursors.left!, wasd.a),
      right: this.mergeKeys(cursors.right!, wasd.d),
      enter: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.E),
      escape: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.ESC),
    };

    // Create building zones
    BUILDING_ZONES.forEach((bz) => {
      const zone = this.add.zone(
        bz.x + bz.width / 2,
        bz.y + bz.height / 2,
        bz.width,
        bz.height
      );
      this.physics.add.existing(zone, true); // static body
      zone.setData('locationId', bz.id);
      this.zones.push(zone);
    });

    // E key: enter building
    this.controls.enter.on('down', () => {
      const state = useGameStore.getState();
      if (state.nearLocation && !state.chatOpen) {
        state.enterBuilding(state.nearLocation);
      }
    });

    // Escape key: exit building
    this.controls.escape.on('down', () => {
      const state = useGameStore.getState();
      if (state.chatOpen) {
        state.exitBuilding();
      }
    });
  }

  update(): void {
    const store = useGameStore.getState();

    // Freeze movement while chat is open
    if (store.movementFrozen) {
      this.avatar.body.setVelocity(0, 0);
      return;
    }

    // Movement
    let vx = 0;
    let vy = 0;

    if (this.controls.left.isDown) vx -= PET_SPEED;
    if (this.controls.right.isDown) vx += PET_SPEED;
    if (this.controls.up.isDown) vy -= PET_SPEED;
    if (this.controls.down.isDown) vy += PET_SPEED;

    // Normalize diagonal movement
    if (vx !== 0 && vy !== 0) {
      const factor = Math.SQRT1_2; // ~0.707
      vx *= factor;
      vy *= factor;
    }

    this.avatar.body.setVelocity(vx, vy);

    // Update position in store
    store.setPetPosition(
      Math.round(this.avatar.x),
      Math.round(this.avatar.y)
    );

    // Zone overlap detection
    let foundZone: string | null = null;
    const pBody = this.avatar.body as Phaser.Physics.Arcade.Body;
    const petBounds = new Phaser.Geom.Rectangle(pBody.x, pBody.y, pBody.width, pBody.height);

    for (const zone of this.zones) {
      const zBody = zone.body as Phaser.Physics.Arcade.StaticBody;
      const zoneBounds = new Phaser.Geom.Rectangle(
        zBody.x,
        zBody.y,
        zBody.width,
        zBody.height
      );
      if (Phaser.Geom.Intersects.RectangleToRectangle(petBounds, zoneBounds)) {
        foundZone = zone.getData('locationId') as string;
        break;
      }
    }

    if (foundZone !== this.currentOverlapZone) {
      this.currentOverlapZone = foundZone;
      store.setNearLocation(foundZone);
    }
  }

  /** Helper: returns first key so Phaser recognizes isDown from either key */
  private mergeKeys(
    primary: Phaser.Input.Keyboard.Key,
    secondary: Phaser.Input.Keyboard.Key
  ): Phaser.Input.Keyboard.Key {
    // We create a virtual key that delegates isDown to either key
    const proxy = new Proxy(primary, {
      get(target, prop) {
        if (prop === 'isDown') {
          return target.isDown || secondary.isDown;
        }
        return (target as any)[prop];
      },
    });
    return proxy;
  }
}
