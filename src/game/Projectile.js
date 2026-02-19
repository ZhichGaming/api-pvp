const { BULLET_SPEED, BULLET_MAX_LIFETIME_TICKS, BULLET_DAMAGE, BULLET_SIZE } = require('./constants');

class Projectile {
  constructor(id, ownerId, x, y, dx, dy) {
    this.id = id;
    this.ownerId = ownerId;
    this.x = x;
    this.y = y;
    this.dx = dx * BULLET_SPEED;  // velocity x per tick
    this.dy = dy * BULLET_SPEED;  // velocity y per tick
    this.damage = BULLET_DAMAGE;
    this.alive = true;
    this.ticksLived = 0;
    this.maxLifetime = BULLET_MAX_LIFETIME_TICKS;
    this.size = BULLET_SIZE;          // collision radius
  }

  tick() {
    if (!this.alive) return;
    this.x += this.dx;
    this.y += this.dy;
    this.ticksLived++;
    if (this.ticksLived >= this.maxLifetime) {
      this.alive = false;
    }
  }

  destroy() {
    this.alive = false;
  }

  toJSON() {
    return {
      id: this.id,
      ownerId: this.ownerId,
      x: this.x,
      y: this.y,
      dx: this.dx,
      dy: this.dy,
      alive: this.alive,
    };
  }
}

module.exports = Projectile;
