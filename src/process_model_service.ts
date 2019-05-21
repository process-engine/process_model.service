import {
  BpmnType,
  IModelParser,
  IProcessDefinitionRepository,
  IProcessModelService,
  Model,
  ProcessDefinitionFromRepository,
} from '@process-engine/process_model.contracts';

import {IIAMService, IIdentity} from '@essential-projects/iam_contracts';

import {ForbiddenError, NotFoundError, UnprocessableEntityError} from '@essential-projects/errors_ts';

import * as clone from 'clone';
import {Logger} from 'loggerhythm';

const logger: Logger = Logger.createLogger('processengine:persistence:process_model_service');

const canReadProcessModelClaim: string = 'can_read_process_model';
const canWriteProcessModelClaim: string = 'can_write_process_model';

export class ProcessModelService implements IProcessModelService {

  private readonly processDefinitionRepository: IProcessDefinitionRepository;
  private readonly iamService: IIAMService;
  private readonly bpmnModelParser: IModelParser = undefined;

  constructor(
    bpmnModelParser: IModelParser,
    iamService: IIAMService,
    processDefinitionRepository: IProcessDefinitionRepository,
  ) {

    this.processDefinitionRepository = processDefinitionRepository;
    this.iamService = iamService;
    this.bpmnModelParser = bpmnModelParser;
  }

  public async persistProcessDefinitions(identity: IIdentity,
                                         name: string,
                                         xml: string,
                                         overwriteExisting: boolean = true,
                                       ): Promise<void> {

    await this.iamService.ensureHasClaim(identity, canWriteProcessModelClaim);
    await this.validateDefinition(name, xml);

    return this.processDefinitionRepository.persistProcessDefinitions(name, xml, overwriteExisting);
  }

  public async getProcessModels(identity: IIdentity): Promise<Array<Model.Process>> {

    await this.iamService.ensureHasClaim(identity, canReadProcessModelClaim);

    const processModelList: Array<Model.Process> = await this.getProcessModelList();

    const filteredList: Array<Model.Process> = [];

    for (const processModel of processModelList) {
      const filteredProcessModel: Model.Process =
        await this.filterInaccessibleProcessModelElements(identity, processModel);

      if (filteredProcessModel) {
        filteredList.push(filteredProcessModel);
      }
    }

    return filteredList;
  }

  public async getProcessModelById(identity: IIdentity, processModelId: string): Promise<Model.Process> {

    await this.iamService.ensureHasClaim(identity, canReadProcessModelClaim);

    const processModel: Model.Process = await this.retrieveProcessModel(processModelId);

    const filteredProcessModel: Model.Process = await this.filterInaccessibleProcessModelElements(identity, processModel);

    if (!filteredProcessModel) {
      throw new ForbiddenError('Access denied.');
    }

    return filteredProcessModel;
  }

  public async getByHash(identity: IIdentity, processModelId: string, hash: string): Promise<Model.Process> {

    await this.iamService.ensureHasClaim(identity, canReadProcessModelClaim);

    const definitionRaw: ProcessDefinitionFromRepository = await this.processDefinitionRepository.getByHash(hash);

    const parsedDefinition: Model.Definitions = await this.bpmnModelParser.parseXmlToObjectModel(definitionRaw.xml);
    const processModel: Model.Process = parsedDefinition.processes.find((entry: Model.Process) => {
      return entry.id === processModelId;
    });

    const filteredProcessModel: Model.Process = await this.filterInaccessibleProcessModelElements(identity, processModel);

    if (!filteredProcessModel) {
      throw new ForbiddenError('Access denied.');
    }

    return filteredProcessModel;
  }

  public async getProcessDefinitionAsXmlByName(identity: IIdentity, name: string): Promise<ProcessDefinitionFromRepository> {

    await this.iamService.ensureHasClaim(identity, canReadProcessModelClaim);

    const definitionRaw: ProcessDefinitionFromRepository = await this.processDefinitionRepository.getProcessDefinitionByName(name);

    if (!definitionRaw) {
      throw new NotFoundError(`Process definition with name "${name}" not found!`);
    }

    return definitionRaw;
  }

  public async deleteProcessDefinitionById(processModelId: string): Promise<void> {
    this.processDefinitionRepository.deleteProcessDefinitionById(processModelId);
  }

  private async validateDefinition(name: string, xml: string): Promise<void> {

    let parsedProcessDefinition: Model.Definitions;

    try {
      parsedProcessDefinition = await this.bpmnModelParser.parseXmlToObjectModel(xml);
    } catch (error) {
      logger.error(`The XML for process "${name}" could not be parsed: ${error.message}`);
      const errorMessage: string = `The XML for process "${name}" could not be parsed.`;
      const parsingError: UnprocessableEntityError = new UnprocessableEntityError(errorMessage);

      parsingError.additionalInformation = error;

      throw parsingError;
    }

    const processDefinitionHasMoreThanOneProcessModel: boolean = parsedProcessDefinition.processes.length > 1;
    if (processDefinitionHasMoreThanOneProcessModel) {
      const tooManyProcessModelsError: string = `The XML for process "${name}" contains more than one ProcessModel. This is currently not supported.`;
      logger.error(tooManyProcessModelsError);

      throw new UnprocessableEntityError(tooManyProcessModelsError);
    }

    const processsModel: Model.Process = parsedProcessDefinition.processes[0];

    const processModelIdIsNotEqualToDefinitionName: boolean = processsModel.id !== name;
    if (processModelIdIsNotEqualToDefinitionName) {
      const namesDoNotMatchError: string = `The ProcessModel contained within the diagram "${name}" must also use the name "${name}"!`;
      logger.error(namesDoNotMatchError);

      throw new UnprocessableEntityError(namesDoNotMatchError);
    }
  }

  private async retrieveProcessModel(processModelId: string): Promise<Model.Process> {

    const processModelList: Array<Model.Process> = await this.getProcessModelList();

    const matchingProcessModel: Model.Process = processModelList.find((processModel: Model.Process): boolean => {
      return processModel.id === processModelId;
    });

    if (!matchingProcessModel) {
      throw new NotFoundError(`ProcessModel with id ${processModelId} not found!`);
    }

    return matchingProcessModel;
  }

  private async getProcessModelList(): Promise<Array<Model.Process>> {

    const definitions: Array<Model.Definitions> = await this.getDefinitionList();

    const allProcessModels: Array<Model.Process> = [];

    for (const definition of definitions) {
      Array.prototype.push.apply(allProcessModels, definition.processes);
    }

    return allProcessModels;
  }

  private async getDefinitionList(): Promise<Array<Model.Definitions>> {

    const definitionsRaw: Array<ProcessDefinitionFromRepository> = await this.processDefinitionRepository.getProcessDefinitions();

    const definitionsMapper: any = async(rawProcessModelData: ProcessDefinitionFromRepository): Promise<Model.Definitions> => {
      return this.bpmnModelParser.parseXmlToObjectModel(rawProcessModelData.xml);
    };

    const definitionsList: Array<Model.Definitions> =
      await Promise.map<ProcessDefinitionFromRepository, Model.Definitions>(definitionsRaw, definitionsMapper);

    return definitionsList;
  }

  private async filterInaccessibleProcessModelElements(identity: IIdentity,
                                                        processModel: Model.Process,
                                                       ): Promise<Model.Process> {

    const processModelCopy: Model.Process = clone(processModel);

    const processModelHasNoLanes: boolean = !(processModel.laneSet && processModel.laneSet.lanes && processModel.laneSet.lanes.length > 0);
    if (processModelHasNoLanes) {
      return processModelCopy;
    }

    processModelCopy.laneSet = await this.filterOutInaccessibleLanes(processModelCopy.laneSet, identity);
    processModelCopy.flowNodes = this.getFlowNodesForLaneSet(processModelCopy.laneSet, processModel.flowNodes);

    const processModelHasAccessibleStartEvent: boolean = this.checkIfProcessModelHasAccessibleStartEvents(processModelCopy);

    if (!processModelHasAccessibleStartEvent) {
      return undefined;
    }

    return processModelCopy;
  }

  private async filterOutInaccessibleLanes(laneSet: Model.ProcessElements.LaneSet, identity: IIdentity): Promise<Model.ProcessElements.LaneSet> {

    const filteredLaneSet: Model.ProcessElements.LaneSet = clone(laneSet);
    filteredLaneSet.lanes = [];

    for (const lane of laneSet.lanes) {

      const userCanNotAccessLane: boolean = !await this.checkIfUserHasClaim(identity, lane.name);
      const filteredLane: Model.ProcessElements.Lane = clone(lane);

      if (userCanNotAccessLane) {
        filteredLane.flowNodeReferences = [];
        delete filteredLane.childLaneSet;
      }

      const laneHasChildLanes: boolean = filteredLane.childLaneSet !== undefined &&
                                         filteredLane.childLaneSet !== null;

      if (laneHasChildLanes) {
        filteredLane.childLaneSet = await this.filterOutInaccessibleLanes(filteredLane.childLaneSet, identity);
      }

      filteredLaneSet.lanes.push(filteredLane);
    }

    return filteredLaneSet;
  }

  private async checkIfUserHasClaim(identity: IIdentity, laneName: string): Promise<boolean> {
    try {
      await this.iamService.ensureHasClaim(identity, laneName);

      return true;
    } catch (error) {
      return false;
    }
  }

  private getFlowNodesForLaneSet(laneSet: Model.ProcessElements.LaneSet, flowNodes: Array<Model.Base.FlowNode>): Array<Model.Base.FlowNode> {

    const accessibleFlowNodes: Array<Model.Base.FlowNode> = [];

    for (const lane of laneSet.lanes) {

      // NOTE: flowNodeReferences are stored in both, the parent lane AND in the child lane!
      // So if we have a lane A with two Sublanes B and C, we must not evaluate the elements from lane A!
      // Consider a user who can only access sublane B.
      // If we were to allow him access to all references stored in lane A, he would also be granted access to the elements
      // from lane C, since they are contained within the reference set of lane A!
      const childLaneSetIsNotEmpty: boolean = lane.childLaneSet !== undefined &&
                                              lane.childLaneSet !== null &&
                                              lane.childLaneSet.lanes !== undefined &&
                                              lane.childLaneSet.lanes !== null &&
                                              lane.childLaneSet.lanes.length > 0;

      if (childLaneSetIsNotEmpty) {
        const accessibleChildLaneFlowNodes: Array<Model.Base.FlowNode> =
        this.getFlowNodesForLaneSet(lane.childLaneSet, flowNodes);

        accessibleFlowNodes.push(...accessibleChildLaneFlowNodes);
      } else {
        for (const flowNodeId of lane.flowNodeReferences) {
          const matchingFlowNode: Model.Base.FlowNode = flowNodes.find((flowNode: Model.Base.FlowNode): boolean => {
            return flowNode.id === flowNodeId;
          });

          if (matchingFlowNode) {
            accessibleFlowNodes.push(matchingFlowNode);
          }
        }
      }
    }

    return accessibleFlowNodes;
  }

  private checkIfProcessModelHasAccessibleStartEvents(processModel: Model.Process): boolean {

    // For this check to pass, it is sufficient for the ProcessModel to have at least one accessible start event.
    const processModelHasAccessibleStartEvent: boolean = processModel.flowNodes.some((flowNode: Model.Base.FlowNode): boolean => {
      return flowNode.bpmnType === BpmnType.startEvent;
    });

    return processModelHasAccessibleStartEvent;
  }
}
