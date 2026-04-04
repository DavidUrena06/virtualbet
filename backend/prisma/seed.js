// prisma/seed.js
// Crea el usuario admin inicial
// Correr con: npm run seed

require('dotenv').config({ path: '../.env' });
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const adminEmail    = process.env.ADMIN_EMAIL    || 'admin@virtualbet.com';
  const adminUsername = process.env.ADMIN_USERNAME || 'admin';
  const adminPassword = process.env.ADMIN_PASSWORD || 'Admin1234!';

  // Verifica si ya existe
  const existing = await prisma.user.findUnique({ where: { email: adminEmail } });

  if (existing) {
    console.log('✅ Admin ya existe:', adminEmail);
    return;
  }

  const passwordHash = await bcrypt.hash(adminPassword, 12);

  const admin = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        username: adminUsername,
        email: adminEmail,
        passwordHash,
        role: 'ADMIN',
      },
    });

    await tx.wallet.create({
      data: {
        userId: user.id,
        balance: 0, // El admin no necesita balance
      },
    });

    return user;
  });

  console.log('✅ Admin creado exitosamente');
  console.log('   Email:    ', adminEmail);
  console.log('   Username: ', adminUsername);
  console.log('   Contraseña definida en .env → ADMIN_PASSWORD');
  console.log('\n⚠️  Cambiá la contraseña del admin en el primer login!');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
