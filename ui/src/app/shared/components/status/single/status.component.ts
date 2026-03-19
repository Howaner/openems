import { CommonModule } from "@angular/common";
import { Component, OnDestroy, OnInit } from "@angular/core";
import { IonicModule, ModalController } from "@ionic/angular";
import { TranslateModule } from "@ngx-translate/core";
import { Subject } from "rxjs";
import { takeUntil } from "rxjs/operators";
import { JsonrpcResponseSuccess } from "src/app/shared/jsonrpc/base";
import { ComponentJsonApiRequest } from "src/app/shared/jsonrpc/request/componentJsonApiRequest";
import { GetStateChannelsOfComponentRequest } from "src/app/shared/jsonrpc/request/getStateChannelsOfComponentRequest";
import { GetChannelsOfComponentResponse } from "src/app/shared/jsonrpc/response/getChannelsOfComponentResponse";
import { ChannelAddress, EdgePermission, Service, Websocket } from "src/app/shared/shared";

import { CurrentData } from "../../edge/currentdata";
import { Edge } from "../../edge/edge";
import { EdgeConfig } from "../../edge/edgeconfig";

interface StateCategory {
    label: string;
    icon: string;
    color: string;
    components: EdgeConfig.Component[];
}

@Component({
    selector: StatusSingleComponent.SELECTOR,
    templateUrl: "./status.component.html",
    standalone: true,
    imports: [
        CommonModule,
        TranslateModule,
        IonicModule,
    ],
})
export class StatusSingleComponent implements OnInit, OnDestroy {
    private static readonly SELECTOR = "oe-status-single";

    public subscribedInfoChannels: ChannelAddress[] = [];
    public onInfoChannels: ChannelAddress[] = [];
    public edge: Edge | null = null;
    public config: EdgeConfig | null = null;
    protected allComponents: EdgeConfig.Component[] = [];
    protected stateCategories: StateCategory[] = [];
    protected openCategories: string[] = [];
    private seenCategories: Set<string> = new Set();
    protected channels: { [componentId: string]: { [channelId: string]: { text: string, level: string } } } = {};

    private stopOnDestroy: Subject<void> = new Subject<void>();

    constructor(
        public modalCtrl: ModalController,
        public service: Service,
        private websocket: Websocket,
    ) { }

    ngOnDestroy() {
        this.edge?.unsubscribeChannels(this.websocket, StatusSingleComponent.SELECTOR);
        this.stopOnDestroy.next();
        this.stopOnDestroy.complete();
    }

    async ngOnInit() {
        this.config = await this.service.getConfig();
        this.allComponents = this.config.listActiveComponents([], this.service.translate)
            .flatMap(cat => cat.components)
            .filter(c => c.id !== "_sum");

        this.allComponents.forEach(component => {
            // sets all arrow buttons to standard position (folded)
            component.showProperties = false;
            this.subscribedInfoChannels.push(
                new ChannelAddress(component.id, "State"),
            );
        });

        //need to subscribe on currentedge because component is opened by app.component
        this.service.getCurrentEdge().then(edge => {
            this.edge = edge;
            edge.subscribeChannels(this.websocket, StatusSingleComponent.SELECTOR, this.subscribedInfoChannels);

            edge.currentData.pipe(takeUntil(this.stopOnDestroy)).subscribe(currentData => {
                if (!currentData) { return; }
                this.stateCategories = this.buildStateCategories(currentData);
            });
        });
    }

    private buildStateCategories(currentData: CurrentData): StateCategory[] {
        const deactivated = this.allComponents.filter(c => !c.isEnabled);
        const enabledWithState = (state: number) =>
            this.allComponents.filter(c => c.isEnabled && (currentData.channel[c.id + "/State"] ?? 0) === state);

        const categories: StateCategory[] = [
            { label: "GENERAL.FAULT", icon: "oe-error", color: "danger", components: enabledWithState(3) },
            { label: "GENERAL.WARNING", icon: "oe-warning", color: "warning", components: enabledWithState(2) },
            { label: "GENERAL.INFO", icon: "oe-info", color: "success", components: enabledWithState(1) },
            { label: "EDGE.CONFIG.ALERTING.DEACTIVATED", icon: "close-circle-outline", color: "medium", components: deactivated },
        ];
        const result = categories.filter(cat => cat.components.length > 0);
        for (const cat of result) {
            if (!this.seenCategories.has(cat.label)) {
                this.seenCategories.add(cat.label);
                this.openCategories = [...this.openCategories, cat.label];
            }
        }
        return result;
    }

    public async subscribeInfoChannels(component: EdgeConfig.Component) {
        const channels = await this.getStateChannels(component.id);
        for (const key of Object.keys(channels)) {
            const channelAddress = new ChannelAddress(component.id, key);
            this.subscribedInfoChannels.push(channelAddress);
            this.onInfoChannels.push(channelAddress);
        }
        this.channels[component.id] = channels;
        this.edge?.subscribeChannels(this.websocket, StatusSingleComponent.SELECTOR, this.subscribedInfoChannels);
    }

    public unsubscribeInfoChannels(component: EdgeConfig.Component) {
        delete this.channels[component.id];
        //removes unsubscribed elements from subscribedInfoChannels array
        this.onInfoChannels.forEach(onInfoChannel => {
            this.subscribedInfoChannels.forEach((subChannel, index) => {
                if (onInfoChannel.channelId == subChannel.channelId && component.id == subChannel.componentId) {
                    this.subscribedInfoChannels.splice(index, 1);
                }
            });
        });
        //clear onInfoChannels Array
        this.onInfoChannels = this.onInfoChannels.filter((channel) => channel.componentId != component.id);
        this.edge?.subscribeChannels(this.websocket, StatusSingleComponent.SELECTOR, this.subscribedInfoChannels);
    }

    private getStateChannels(componentId: string): Promise<typeof this.channels["componentId"]> {
        return new Promise((resolve, reject) => {
            if (this.edge == null) {
                reject("No edge selected");
                return;
            }
            if (EdgePermission.hasChannelsInEdgeConfig(this.edge)) {
                const channels: typeof this.channels["componentId"] = {};
                if (this.config == null || this.config.components[componentId] == null) {
                    reject("Component not found in EdgeConfig");
                    return;
                }

                const configChannels = this.config.components[componentId].channels ?? {};

                for (const [key, value] of Object.entries(configChannels)) {

                    // show only state channels
                    if (value.category !== "STATE") {
                        continue;
                    }

                    channels[key] = { text: value.text, level: value.level };
                }
                resolve(channels);
                return;
            }

            this.edge.sendRequest<JsonrpcResponseSuccess>(this.websocket, new ComponentJsonApiRequest({
                componentId: "_componentManager",
                payload: new GetStateChannelsOfComponentRequest({ componentId: componentId }),
            })).then((response) => {
                const data = response as GetChannelsOfComponentResponse;
                const channels: typeof this.channels["componentId"] = {};
                for (const item of data.result.channels) {
                    channels[item.id] = { text: item.text, level: item.level };
                }
                resolve(channels);
            }).catch(reject);
        });
    }

}
