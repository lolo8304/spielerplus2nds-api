import { Body, Controller, Get, Post, Query, Sse } from '@nestjs/common';
import { map } from 'rxjs';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getRoot() {
    return this.appService.getConfig();
  }

  @Get('config')
  getConfig() {
    return this.appService.getConfig();
  }

  @Get('teams')
  getTeams(@Query('season') season?: string) {
    return this.appService.listTeamStatuses(season);
  }

  @Get('downloads')
  getDownloads(@Query('season') season?: string) {
    return this.appService.listDownloads(season);
  }

  @Get('wildcards')
  getWildcards(
    @Query('season') season?: string,
    @Query('targetId') targetId?: string,
  ) {
    return this.appService.listWildcards(season, targetId);
  }

  @Post('generate')
  generate(@Body() body: { season?: string; targetId?: string }) {
    return this.appService.generate(body.season, body.targetId);
  }

  @Sse('downloads/events')
  getDownloadEvents() {
    return this.appService.getDownloadEvents().pipe(map((data) => ({ data })));
  }

  @Post('downloads/move')
  moveDownload(
    @Body()
    body: {
      filename: string;
      team?: string;
      targetId?: string;
      season?: string;
    },
  ) {
    return this.appService.moveDownload(
      body.filename,
      body.targetId ?? body.team ?? '',
      body.season,
    );
  }

  @Post('downloads/clear')
  clearDownload(@Body() body: { filename: string; season?: string }) {
    return this.appService.clearDownload(body.filename, body.season);
  }
}
