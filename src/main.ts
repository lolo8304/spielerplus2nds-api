import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors({
    origin: process.env.APP_ORIGIN ?? 'http://localhost:5173',
  });
  await app.listen(process.env.PORT ?? 3002);
}
void bootstrap();
